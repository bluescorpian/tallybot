# TallyBot — Project Instructions for Claude

WiFi camera tally light system for live video production. A Tauri desktop app reads
ATEM Mini switcher state and drives ESP32-C3 LED devices over WiFi.

**[`docs/architecture.md`](docs/architecture.md) is the source of truth** for design
decisions, the network/binary protocol, and rationale. Read it before changing anything
structural. This file is the working guide; keep the two consistent.

> **Keep this file true.** CLAUDE.md is always in context. If a change you make falsifies a claim here — a path changes, a gotcha is resolved, a command changes — **propose an update to this file in the same turn** rather than letting it drift. Don't silently rewrite it; surface the proposed edit to the user. Record only **durable facts** — what the code *is* and how it behaves. Never write transient status: no dates, no "just rewritten", "pending verification", "software-complete", or "verified on hardware". That kind of note rots within a commit or two; write what stays true so the file rarely needs touching.

## Repository layout

- `app/` — Tauri 2 desktop app: SvelteKit UI (`src/`), Rust shell (`src-tauri/`),
  and the Node.js sidecar backend (`sidecar/`).
- `firmware/` — ESP32-C3 device firmware (PlatformIO + Arduino + FastLED).
- `tools/` — ATEM + tally-client simulators (hardware-free dev).

Explore the tree for current files rather than trusting a static listing — specifics
drift as the project grows.

## Components & how they fit

- **Sidecar** is the brain: it connects to the ATEM, runs the TCP server and UDP
  discovery, maps device MACs to ATEM-input assignments, and translates ATEM
  program/preview state into `SET_COLOR` commands.
- **Svelte UI** talks to the sidecar over Tauri IPC (schema shape set in `docs/goals.md` / `docs/design.md`).
- **Firmware** is a TCP *client*: it discovers the server, connects, sends `HELLO`
  then `HEARTBEAT`s, and applies `SET_COLOR` / `IDENTIFY` commands to the LED.

Data flow: `ATEM state change → sidecar → TCP → ESP32 → WS2812 LED`.

## Protocol quick reference

**Framing is transport-specific; payloads are shared.** The `[type][fields…]` payloads
ride unchanged over both transports; only the wrapper differs. TCP uses length-prefix
framing (`[len][payload…]`, `len` = payload byte count); USB-CDC uses COBS (self-syncing on
a `0x00` delimiter, framed by PacketSerial on the device and a hand-rolled codec in the Rust
shell). Full tables in `docs/architecture.md`; USB details in `docs/spec/usb-serial-protocol.md`.

- **Discovery (UDP 7001):** device broadcasts `TALLY_FIND`; server replies/broadcasts
  `TALLY_HERE:7000`.
- **Device → server:** `0x01` HELLO `[type][version][mac×6]`, `0x02` HEARTBEAT `[type]`.
  USB also: `0x03` STATUS `[transport][wifiState][rssi][ssidLen][ssid…]`, `0x04` LOG
  `[level][utf8…]`. STATUS carries the device's NVS SSID (host adopts it as truth) and the
  full `wifiState` enum, and is pushed on change while cabled (not just on `GET_STATUS`).
- **Server → device:** `0x01` SET_COLOR `[type][R][G][B][brightness]`, `0x02` IDENTIFY
  `[type]`. USB also: `0x03` SET_WIFI, `0x04` SET_TRANSPORT, `0x05` GET_STATUS (`0x07` RELAY
  reserved for v1.3).
- **Versioning:** HELLO carries the device's protocol version; the server keeps `CURRENT`
  (**2** — USB provisioning) + `MIN_SUPPORTED` (1) and adapts to older devices (warns
  below `MIN_SUPPORTED`). Protocol constants are mirrored in three places: `protocol.ts`
  (source of truth), `firmware/src/protocol.h`, and `app/src-tauri/src/usb/protocol.rs`
  (minimal: COBS + HELLO only).
- **Colours:** Live `255,0,0` · Preview `0,255,0` · Idle `30,30,30` (dim white) ·
  Unassigned `255,255,255` (white, server-driven breathe) · Disconnected `0,0,255` (device-local
  steady blue) · Fault `0,0,255` flashing (server-driven, when the source can't be trusted —
  never idle). Default brightness `128`. Full palette in `docs/led.md`.
- **Animation lives in the server.** Connected-state motion (the fault flash, the unassigned
  breathe) is driven by the sidecar streaming frames; the firmware renders static `SET_COLOR`s
  and only animates device-local bring-up states (no server connected yet).
- **Identity:** devices are keyed by MAC address.

## Dev environment (NixOS)

`flake.nix` provides the whole toolchain: Rust, `cargo-tauri`, Node, pnpm, and the
`webkit2gtk-4.1` / `librsvg` system libs Tauri needs on Linux. With direnv it loads
on `cd` (run `direnv allow` once).

## Commands

```bash
# App — Tauri 2 + SvelteKit (run inside the nix dev shell)
cd app && pnpm install              # frontend deps (once)
cd app && cargo tauri dev           # run desktop app (compiles the Rust shell)
cd app && cargo tauri build         # production build
cd app && pnpm build                # frontend only -> app/build

# Firmware (PlatformIO)
cd firmware && pio run              # build
cd firmware && pio run -e esp32-c3-release -t upload    # flash with the release env (COBS framing + logs)
cd firmware && pio device monitor   # serial @ 115200

# Sidecar (Node.js) — standalone dev
cd app/sidecar && pnpm install
cd app/sidecar && pnpm start        # run with FakeAtem
```

## Conventions

- TypeScript is strict. Networking uses Node built-ins (`net`, `dgram`) — no
  third-party networking libs.
- Keep the protocol constants in sync across the **three** mirrors that encode the same
  spec: `app/sidecar/src/protocol.ts` (source of truth), `firmware/src/protocol.h`, and
  `app/src-tauri/src/usb/protocol.rs` (minimal — COBS framing + HELLO parse only; the shell
  forwards every other payload opaque so `protocol.ts` stays the single payload codec).
- **Firmware is lean; the sidecar owns connected-state behaviour.** Logic and animation belong
  in the server (easy to change) rather than on the flashed device — the device renders what
  it's told. See `docs/led.md`.
- The same-subnet limitation is accepted and intentional — document it for users
  rather than working around it.
- This will be open-sourced: favour simplicity and clarity, and explain tradeoffs
  when introducing a new pattern.

## Reference documents — what they cover and when to load them

Docs live in `docs/`. Load them on demand; don't bulk-load.

| File | Covers | Load when… |
|------|--------|------------|
| **`docs/architecture.md`** | Source-of-truth: protocol spec, IPC schema, network topology, failure modes, packaging. | Touching the binary protocol, TCP/UDP server, ATEM adapter, IPC bridge, or any structural decision. Always read before a structural change. |
| **`docs/goals.md`** | Product intent and user-facing decisions (what we're building and why). | Evaluating whether a feature belongs in the product, or reconciling a tradeoff against user intent. |
| **`docs/design.md`** | UI visual and interaction design: house style, locked primitives, IPC UI schema, open design questions. | Any frontend / Svelte UI work. Not needed for backend, protocol, or firmware work. |
| **`docs/led.md`** | LED palette: every device state, colour, motion, and the design rules. | Touching LED state logic in firmware or sidecar, or discussing device-visible states. |
| **`docs/atem-connection-notes.md`** | Sharp edges and gotchas with the `atem-connection` library; field-test findings. | Debugging ATEM connectivity, extending the ATEM adapter, or integrating new ATEM state. |
| **`docs/packaging-windows.md`** | Step-by-step Windows build guide. | Building or testing the Windows portable binary. |
| **`docs/milestones/v1.1-production-hardening.md`** | Production-hardening worklist: diagnostics + LED palette, WiFi-join reliability (deferred), transport pivot to ESP-NOW. | Reviewing what production-hardening shipped or deferred. |
| **`docs/milestones/v1.2-zero-friction-onboarding.md`** | Zero-friction onboarding: in-app USB flashing + WiFi/No-TX provisioning over USB-C. | Working on USB onboarding; pair with `docs/spec/usb-serial-protocol.md`. |
| **`docs/wifi-troubleshooting.md`** | Living runbook for the deferred WiFi-join problem: symptoms, the diagnostics-panel verdict, what's ruled out, current hypothesis, what to try next. | Returning to WiFi-join reliability, or reading a device's SoftAP diagnostics panel. |
| **`docs/milestones/roadmap.md`** | Deferred / future work (ESP-NOW transport, OTA, web UI, OBS, multi-switcher). | Evaluating roadmap items or planning the next milestone. |
| **`docs/spec/`** | Pre-implementation feature specs: decisions, alternatives rejected, acceptance criteria. One file per feature; written before coding, archived or deleted when shipped. Current: `usb-serial-protocol.md` (v1.2 USB onboarding). | Designing or reviewing a feature before touching code. |
| **`app/sidecar/SIDECAR.md`** | How the Node.js sidecar process works alongside Tauri: lifecycle, IPC transport, why this pattern. | Working on Tauri ↔ sidecar integration, the sidecar launch/shutdown flow, or IPC transport internals. |
| **`app/sidecar/README.md`** | Day-to-day sidecar dev guide: how to run, test, and iterate on the sidecar in isolation. | Running or debugging the sidecar standalone, onboarding to sidecar development. |
| **`tools/README.md`** | Hardware simulators: FakeAtem, fake ESP32 TCP client, sidecar-dev REPL, end-to-end test. | Using or extending the dev tools; hardware-free testing. |

The `.exploration/` subtree holds vendored source snapshots for research only — don't load it unless reverse-engineering a specific `atem-connection` or `threadedClass` behaviour.

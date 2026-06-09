# TallyBot — Project Instructions for Claude

WiFi camera tally light system for live video production. A Tauri desktop app reads
ATEM Mini switcher state and drives ESP32-C3 LED devices over WiFi.

**[`docs/architecture.md`](docs/architecture.md) is the source of truth** for design
decisions, the network/binary protocol, and rationale. Read it before changing anything
structural. This file is the working guide; keep the two consistent.

> **Keep this file true.** CLAUDE.md is always in context and is the source of truth for
> project status — including the **active milestone** (see [Status](#status)). If a change
> you make falsifies a claim here — status moves, a path changes, a gotcha is resolved, a
> command changes, the active milestone ships — **propose an update to this file in the same
> turn** rather than letting it drift. Don't silently rewrite it; surface the proposed edit
> to the user.

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
  USB also: `0x03` STATUS `[transport][creds][wifiState][rssi]`, `0x04` LOG `[level][utf8…]`.
- **Server → device:** `0x01` SET_COLOR `[type][R][G][B][brightness]`, `0x02` IDENTIFY
  `[type]`. USB also: `0x03` SET_WIFI, `0x04` SET_TRANSPORT, `0x05` GET_STATUS (`0x07` RELAY
  reserved for v1.3).
- **Versioning:** HELLO carries the device's protocol version; the server keeps `CURRENT`
  (now **2** — USB provisioning) + `MIN_SUPPORTED` (1) and adapts to older devices (warns
  below `MIN_SUPPORTED`). Protocol constants are mirrored in three places now: `protocol.ts`
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
cd firmware && pio run -t upload    # flash
cd firmware && pio device monitor   # serial @ 115200

# Sidecar (Node.js) — standalone dev
cd app/sidecar && pnpm install
cd app/sidecar && pnpm start        # run with FakeAtem
```

## Firmware gotchas (ESP32-C3 SuperMini) — these will bite you

1. **GPIO8 is addressable, not digital.** `digitalWrite(8, ...)` does nothing and the
   board looks dead. Always drive the LED via FastLED.
2. **Never sleep.** Deep/light sleep lets the power bank's auto-off cut power
   (low-current detection). Keep WiFi active (~80–130 mA).
3. **WiFi TX power.** Start at full power; only fall back to `WIFI_POWER_8_5dBm` after a
   failed association attempt (older C3 boards with a weak antenna). Never cap it
   unconditionally — it slashes uplink range on venue APs.

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
| **`docs/milestones/v1.1-production-hardening.md`** | **Closed** worklist: diagnostics + LED palette shipped; WiFi-join reliability deferred, transport work pivoted to ESP-NOW. | Reviewing what production-hardening shipped or deferred. |
| **`docs/milestones/v1.2-zero-friction-onboarding.md`** | **Active** milestone: in-app USB flashing + WiFi/No-TX provisioning over USB-C. | Working on USB onboarding; pair with `docs/spec/usb-serial-protocol.md`. |
| **`docs/wifi-troubleshooting.md`** | Living runbook for the deferred WiFi-join problem: symptoms, the diagnostics-panel verdict, what's ruled out, current hypothesis, what to try next. | Returning to WiFi-join reliability, or reading a device's SoftAP diagnostics panel. |
| **`docs/milestones/roadmap.md`** | Deferred / future work (ESP-NOW transport, OTA, web UI, OBS, multi-switcher). | Evaluating roadmap items or planning the next milestone. |
| **`docs/spec/`** | Pre-implementation feature specs: decisions, alternatives rejected, acceptance criteria. One file per feature; written before coding, archived or deleted when shipped. Current: `usb-serial-protocol.md` (v1.2 USB onboarding). | Designing or reviewing a feature before touching code. |
| **`app/sidecar/SIDECAR.md`** | How the Node.js sidecar process works alongside Tauri: lifecycle, IPC transport, why this pattern. | Working on Tauri ↔ sidecar integration, the sidecar launch/shutdown flow, or IPC transport internals. |
| **`app/sidecar/README.md`** | Day-to-day sidecar dev guide: how to run, test, and iterate on the sidecar in isolation. | Running or debugging the sidecar standalone, onboarding to sidecar development. |
| **`tools/README.md`** | Hardware simulators: FakeAtem, fake ESP32 TCP client, sidecar-dev REPL, end-to-end test. | Using or extending the dev tools; hardware-free testing. |

The `.exploration/` subtree holds vendored source snapshots for research only — don't load it unless reverse-engineering a specific `atem-connection` or `threadedClass` behaviour.

## Status

MVP is complete. Production hardening (v1.1) is **closed**: on-device WiFi diagnostics and the
full LED palette (server-driven flash + breathe; lean firmware) shipped and were verified.
WiFi-join reliability hit venue access-point *policy* the device can't change (a weak-signal /
min-RSSI kick) and is **deferred** — see [`docs/wifi-troubleshooting.md`](docs/wifi-troubleshooting.md)
and the roadmap. The **active focus is v1.2 + v1.3 in sequence**: USB provisioning of already-flashed
devices (transport selection + WiFi creds), then ESP-NOW transport — targeting end of week.
In-app firmware flashing (the original v1.2 differentiator) is **deferred** to a later
milestone. Work proceeds in pieces: USB comms → No-TX mode → WiFi provisioning → ESP-NOW.
The v1.2 USB pieces (COBS comms, No-TX mode, WiFi provisioning) are **implemented across
firmware + Rust shell + sidecar and compile/unit-test clean**. The **USB transport path is
hardware-verified** on a physical ESP32-C3: detection (HELLO), live `SET_COLOR` over USB, and
the revert to provisioned mode on unplug (data-USB → power-only). **WiFi provisioning is not
yet hardware-verified** — it needs the wizard UI to drive `SET_WIFI`/`SET_TRANSPORT` and watch
the validating join. The Svelte provisioning UI (wizard + wired indicator) is therefore the
**next piece** — the IPC contract is defined; until it lands, drive provisioning via the
`tools/` sidecar-dev REPL.
Milestones: [`v1.2`](docs/milestones/v1.2-zero-friction-onboarding.md) ·
[`v1.3`](docs/milestones/v1.3-esp-now-transport.md). USB-serial protocol specced in
[`docs/spec/usb-serial-protocol.md`](docs/spec/usb-serial-protocol.md).
**Target platforms: Linux (dev) + Windows (release); macOS is out of scope.**
Closed worklist: [`docs/milestones/v1.1-production-hardening.md`](docs/milestones/v1.1-production-hardening.md).

- **app/sidecar/** — tally engine, device server (now a `CompositeDeviceServer` fanning
  TCP + USB, dedupe-by-MAC USB-preferred), ATEM adapter (real `atem-connection` behind an
  `AtemLike` seam), config store, IPC bridge (UI commands + the internal `usb*` shell bridge),
  `UsbTransport` proxy, and the orchestrator — built and tested.
- **app/ UI** — the board, settings drawer, and frameless chrome, running on the live
  sidecar IPC stream (`src/lib/ipc.svelte.ts`), with a mock fallback for the `/preview`
  design workflow.
- **app/ shell** — `src-tauri/src/lib.rs` spawns the Node sidecar via
  `tauri-plugin-shell`, forwards NDJSON stdout to the UI as `"sidecar"` events, and
  exposes `send_to_sidecar` for UI → sidecar commands. It also **owns the serial port(s)**
  (`src/usb/`, `serialport` crate): a per-port thread COBS-frames, detects HELLO by VID:PID
  `0x303A:0x1001`, and relays `usb*` messages to/from the sidecar over the same stdio bridge.
  Packaging is solved: single-binary sidecar via `@yao-pkg/pkg`, wired into `cargo tauri build`.
- **firmware/** — full tally client: WiFiManager captive-portal provisioning, UDP
  discovery, TCP binary protocol, LED state machine with per-phase colours — plus a USB-CDC
  COBS control channel (PacketSerial) sharing the message dispatch, No-TX mode, and USB WiFi
  provisioning with a validating join. Two PlatformIO envs: dev (text logs) + `esp32-c3-release`
  (frames everything). Verified on a physical ESP32-C3: the pre-USB client, and the USB
  transport path (detect + live `SET_COLOR` + unplug-revert); USB WiFi provisioning still
  pending hardware verification (needs the wizard UI). `protocol.h` mirrors `protocol.ts`.
- **tools/** — ATEM simulator (`FakeAtem`), tally-client simulator, `sidecar-dev` REPL,
  and end-to-end test. See `tools/README.md`.

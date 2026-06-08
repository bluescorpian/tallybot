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

Length-prefixed binary: every message is `[len][payload…]` (`len` = count of payload
bytes that follow). Full tables in `docs/architecture.md`.

- **Discovery (UDP 7001):** device broadcasts `TALLY_FIND`; server replies/broadcasts
  `TALLY_HERE:7000`.
- **Device → server:** `0x01` HELLO `[type][version][mac×6]`, `0x02` HEARTBEAT `[type]`.
- **Server → device:** `0x01` SET_COLOR `[type][R][G][B][brightness]`, `0x02` IDENTIFY
  `[type]`.
- **Versioning:** HELLO carries the device's protocol version; the server keeps `CURRENT`
  + `MIN_SUPPORTED` and adapts to older devices (warns below `MIN_SUPPORTED`).
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
on `cd` (run `direnv allow` once); otherwise prefix commands with `nix develop -c`.

**Use `cargo tauri …`, not `pnpm tauri …`.** This box has only a *stub* nix-ld, so
the npm `@tauri-apps/cli`'s prebuilt binary can't exec — the flake's nix-built
`cargo-tauri` is used instead. Related NixOS/pnpm fix lives in
`app/pnpm-workspace.yaml` (`allowBuilds: esbuild` so pnpm's pre-run deps check
doesn't fail fatally on the blocked esbuild lifecycle script).

**NVIDIA + Wayland: the window won't open** (`Gdk-Message: Error 71 (Protocol
error) dispatching to Wayland display`). WebKitGTK's DMA-BUF renderer commits a
buffer without a Wayland explicit-sync acquire point on the NVIDIA driver; the
compositor kills the window. It's an unresolved upstream WebKit bug
([#280210](https://bugs.webkit.org/show_bug.cgi?id=280210)), not a TallyBot/Tauri
bug — it reproduces in WebKitGTK's own MiniBrowser. The flake's `shellHook` works
around it by exporting `WEBKIT_DISABLE_DMABUF_RENDERER=1`, but **only** when it
detects Wayland + a loaded `nvidia` module (so X11 / AMD / Intel keep the
accelerated path), and only if you haven't set the var yourself. If you're outside
the dev shell, prefix manually: `WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri dev`.
The shipped binary is *not* yet covered — packaging for NVIDIA+Wayland end-users
will need the same env var set (e.g. in `run()`).

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
- Keep the protocol constants in `protocol.ts` (sidecar) and the `#define`s in
  `main.cpp` (firmware) in sync — they encode the same spec.
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
| **`docs/wifi-troubleshooting.md`** | Living runbook for the deferred WiFi-join problem: symptoms, the diagnostics-panel verdict, what's ruled out, current hypothesis, what to try next. | Returning to WiFi-join reliability, or reading a device's SoftAP diagnostics panel. |
| **`docs/milestones/roadmap.md`** | Deferred / future work (ESP-NOW transport — active focus, OTA, web UI, OBS, multi-switcher). | Evaluating roadmap items or planning the next milestone. |
| **`app/sidecar/SIDECAR.md`** | How the Node.js sidecar process works alongside Tauri: lifecycle, IPC transport, why this pattern. | Working on Tauri ↔ sidecar integration, the sidecar launch/shutdown flow, or IPC transport internals. |
| **`app/sidecar/README.md`** | Day-to-day sidecar dev guide: how to run, test, and iterate on the sidecar in isolation. | Running or debugging the sidecar standalone, onboarding to sidecar development. |
| **`tools/README.md`** | Hardware simulators: FakeAtem, fake ESP32 TCP client, sidecar-dev REPL, end-to-end test. | Using or extending the dev tools; hardware-free testing. |

The `.exploration/` subtree holds vendored source snapshots for research only — don't load it unless reverse-engineering a specific `atem-connection` or `threadedClass` behaviour.

## Status

MVP is complete. Production hardening (v1.1) is **closed**: on-device WiFi diagnostics and the
full LED palette (server-driven flash + breathe; lean firmware) shipped and were verified.
WiFi-join reliability hit venue access-point *policy* the device can't change (a weak-signal /
min-RSSI kick) and is **deferred** — see [`docs/wifi-troubleshooting.md`](docs/wifi-troubleshooting.md)
and the roadmap. The **active focus is now the ESP-NOW transport**
([`docs/milestones/roadmap.md`](docs/milestones/roadmap.md), item 3); a milestone doc will be cut
once it's scoped. Closed worklist: [`docs/milestones/v1.1-production-hardening.md`](docs/milestones/v1.1-production-hardening.md).

- **app/sidecar/** — tally engine, device server (TCP/UDP), ATEM adapter (real
  `atem-connection` behind an `AtemLike` seam), config store, IPC bridge, and the
  orchestrator — built and tested.
- **app/ UI** — the board, settings drawer, and frameless chrome, running on the live
  sidecar IPC stream (`src/lib/ipc.svelte.ts`), with a mock fallback for the `/preview`
  design workflow.
- **app/ shell** — `src-tauri/src/lib.rs` spawns the Node sidecar via
  `tauri-plugin-shell`, forwards NDJSON stdout to the UI as `"sidecar"` events, and
  exposes `send_to_sidecar` for UI → sidecar commands. Packaging is solved: single-binary
  sidecar via `@yao-pkg/pkg`, wired into `cargo tauri build`.
- **firmware/** — full tally client: WiFiManager captive-portal provisioning, UDP
  discovery, TCP binary protocol, LED state machine with per-phase colours. Verified on a
  physical ESP32-C3. `protocol.h` mirrors `protocol.ts`.
- **tools/** — ATEM simulator (`FakeAtem`), tally-client simulator, `sidecar-dev` REPL,
  and end-to-end test. See `tools/README.md`.

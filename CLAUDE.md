# TallyBot — Project Instructions for Claude

WiFi camera tally light system for live video production. A Tauri desktop app reads
ATEM Mini switcher state and drives ESP32-C3 LED devices over WiFi.

**[`ARCHITECTURE.md`](ARCHITECTURE.md) is the source of truth** for design decisions,
the network/binary protocol, and rationale. Read it before changing anything
structural. This file is the working guide; keep the two consistent.

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
- **Svelte UI** talks to the sidecar over Tauri IPC (schema shape set in `GOALS.md` / `DESIGN.md`).
- **Firmware** is a TCP *client*: it discovers the server, connects, sends `HELLO`
  then `HEARTBEAT`s, and applies `SET_COLOR` / `IDENTIFY` commands to the LED.

Data flow: `ATEM state change → sidecar → TCP → ESP32 → WS2812 LED`.

## Protocol quick reference

Length-prefixed binary: every message is `[len][payload…]` (`len` = count of payload
bytes that follow). Full tables in `ARCHITECTURE.md`.

- **Discovery (UDP 7001):** device broadcasts `TALLY_FIND`; server replies/broadcasts
  `TALLY_HERE:7000`.
- **Device → server:** `0x01` HELLO `[type][version][mac×6]`, `0x02` HEARTBEAT `[type]`.
- **Server → device:** `0x01` SET_COLOR `[type][R][G][B][brightness]`, `0x02` IDENTIFY
  `[type]`.
- **Versioning:** HELLO carries the device's protocol version; the server keeps `CURRENT`
  + `MIN_SUPPORTED` and adapts to older devices (warns below `MIN_SUPPORTED`).
- **Colours:** Live `255,0,0` · Preview `0,255,0` · Idle `30,30,30` (dim white) ·
  Disconnected `0,0,255` (device-local steady blue) · Fault `0,0,255` flashing
  (server-driven, when the source can't be trusted — never idle). Default
  brightness `128`. See `ARCHITECTURE.md` "Failure signalling".
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

# Firmware (PlatformIO) — not yet scaffolded
cd firmware && pio run              # build
cd firmware && pio run -t upload    # flash
cd firmware && pio device monitor   # serial @ 115200

# Sidecar (Node.js) — not yet built
cd app/sidecar && pnpm install
```

## Firmware gotchas (ESP32-C3 SuperMini) — these will bite you

1. **GPIO8 is addressable, not digital.** `digitalWrite(8, ...)` does nothing and the
   board looks dead. Always drive the LED via FastLED.
2. **Never sleep.** Deep/light sleep lets the power bank's auto-off cut power
   (low-current detection). Keep WiFi active (~80–130 mA).
3. **WiFi TX power fallback.** On older C3 boards, call
   `WiFi.setTxPower(WIFI_POWER_8_5dBm)` before `WiFi.begin()` if WiFi won't connect.

## Conventions

- TypeScript is strict. Networking uses Node built-ins (`net`, `dgram`) — no
  third-party networking libs.
- Keep the protocol constants in `protocol.ts` (sidecar) and the `#define`s in
  `main.cpp` (firmware) in sync — they encode the same spec.
- The same-subnet limitation is accepted and intentional — document it for users
  rather than working around it.
- This will be open-sourced: favour simplicity and clarity, and explain tradeoffs
  when introducing a new pattern.

## Reference documents — what they cover and when to load them

These docs sit at the repo root (or near it). Load them on demand; don't bulk-load.

| File | Covers | Load when… |
|------|--------|------------|
| **`ARCHITECTURE.md`** | Source-of-truth: protocol spec, IPC schema, network topology, failure modes, design rationale. | Touching the binary protocol, TCP/UDP server, ATEM adapter, IPC bridge, or any structural decision. Always read before a structural change. |
| **`GOALS.md`** | Product intent and user-facing decisions (what we're building and why). | Evaluating whether a feature belongs in the product, or reconciling a tradeoff against user intent. |
| **`PHASES.md`** | Build phases — scope and sequencing of each phase. | Planning what to build next, checking what's in-scope for the current phase, or understanding what a phase depends on. |
| **`DESIGN.md`** | UI visual and interaction design: house style, locked primitives, IPC UI schema, open design questions. | Any frontend / Svelte UI work. Not needed for backend, protocol, or firmware work. |
| **`ATEM-CONNECTION-NOTES.md`** | Sharp edges and gotchas with the `atem-connection` library; field-test findings. | Debugging ATEM connectivity, extending the ATEM adapter, or integrating new ATEM state. |
| **`app/sidecar/SIDECAR.md`** | How the Node.js sidecar process works alongside Tauri: lifecycle, IPC transport, why this pattern. | Working on Tauri ↔ sidecar integration, the sidecar launch/shutdown flow, or IPC transport internals. |
| **`app/sidecar/README.md`** | Day-to-day sidecar dev guide: how to run, test, and iterate on the sidecar in isolation. | Running or debugging the sidecar standalone, onboarding to sidecar development. |
| **`tools/README.md`** | Hardware simulators: FakeAtem, fake ESP32 TCP client, sidecar-dev REPL, end-to-end test. | Using or extending the dev tools; hardware-free testing. |

The `.exploration/` subtree holds vendored source snapshots for research only — don't load it unless reverse-engineering a specific `atem-connection` or `threadedClass` behaviour.

## Status

Per-phase status and acceptance criteria live in [`PHASES.md`](PHASES.md); the
outstanding worklist (what to build next, in order) is in [`TODO.md`](TODO.md). Summary:

- **app/sidecar/** — **Phase 2 done**: tally engine, device server (TCP/UDP), ATEM
  adapter (real `atem-connection` behind an `AtemLike` seam), config store, IPC bridge,
  and the orchestrator that wires them — built and tested (`pnpm start` runs it).
- **app/ UI** — **Phase 4 mostly done**: the board, settings drawer, and frameless
  chrome are built (including per-device brightness in the light popover), but driven by
  **mock data with stub handlers**. Remaining: the live IPC wiring (Phase 5).
- **app/ shell** — **Phase 5 not started**: `src-tauri/src/lib.rs` is still the
  `create-tauri-app` `greet` template. Needs the sidecar↔UI bridge (spawn + stdio↔IPC),
  config (shell capability, `externalBin`), and a packaging strategy (open decision —
  single-binary proved impractical for `atem-connection`; see `TODO.md`).
- **firmware/** — **Phase 3 done**: the full tally client (`platformio.ini`, `src/main.cpp`,
  `src/protocol.h`) — WiFiManager captive-portal provisioning, UDP discovery, the TCP binary
  protocol, and the LED state machine. Builds with `pio run` and **verified on a physical
  ESP32-C3**: provision → discover → connect → live/preview/idle tally → identify → per-device
  brightness, all against the standalone sidecar. `protocol.h` mirrors `protocol.ts`.
- **tools/** — Phase 1 simulators + the Phase 2 dev runner: ATEM simulator (`FakeAtem`)
  and tally-client simulator (a fake ESP32 over TCP), plus `sidecar-dev` (drive the real
  sidecar against the `FakeAtem` from a REPL) and an end-to-end test. See `tools/README.md`.

Roadmap items (OTA, web UI, multi-switcher, OBS integration, simulators) are in
`ARCHITECTURE.md`.

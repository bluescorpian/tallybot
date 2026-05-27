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
  discovery, maps device MACs to camera assignments, and translates ATEM
  program/preview state into `SET_COLOR` commands.
- **Svelte UI** talks to the sidecar over Tauri IPC (event schema not yet designed).
- **Firmware** is a TCP *client*: it discovers the server, connects, sends `HELLO`
  then `HEARTBEAT`s, and applies `SET_COLOR` / `IDENTIFY` commands to the LED.

Data flow: `ATEM state change → sidecar → TCP → ESP32 → WS2812 LED`.

## Protocol quick reference

Fixed-width binary, no framing. Full tables in `ARCHITECTURE.md`.

- **Discovery (UDP 7001):** device broadcasts `TALLY_FIND`; server replies/broadcasts
  `TALLY_HERE:7000`.
- **Device → server (7 bytes):** `[type][mac×6]` — `0x01` HELLO, `0x02` HEARTBEAT.
- **Server → device (5 bytes):** `[type][R][G][B][brightness]` — `0x01` SET_COLOR,
  `0x02` IDENTIFY.
- **Colours:** Live `255,0,0` · Preview `255,180,0` · Idle `0,255,0` ·
  Disconnected `0,0,255`. Default brightness `128`.
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

## Status

- **app/** — Tauri 2 + SvelteKit scaffolded via `create-tauri-app`. Frontend and
  Rust shell both build cleanly in the nix dev shell. UI is still the default
  template; `app/sidecar/` is an empty placeholder.
- **firmware/** — empty; not yet scaffolded (`platformio.ini` + `src/main.cpp`).
- **tools/** — empty; simulators not yet written.

Roadmap items (OTA, web UI, multi-switcher, OBS integration, simulators) are in
`ARCHITECTURE.md`.

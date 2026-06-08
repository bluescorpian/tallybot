# TallyBot — WiFi Tally Light System

Wireless camera tally lights for live video production. A desktop app on the streaming
PC reads switcher state from a **Blackmagic ATEM Mini** and sends colour commands over
WiFi to small **ESP32-C3** devices with an RGB LED. Camera operators see **red** (live),
**green** (preview), or **dim white** (idle) at a glance.

Built for a church video setup, designed to be open-sourced for any small live
production environment.

## How it works

```
ATEM Mini ──UDP/9910──▶ Sidecar (Node.js) ──TCP/7000──▶ ESP32 ──▶ WS2812 LED
                              ▲
                              │ Tauri IPC
                         Svelte UI
```

Devices and the PC find each other automatically over UDP broadcast (port 7001) — no
hardcoded IPs. The only network requirement is that all devices share a subnet.
See [`docs/architecture.md`](docs/architecture.md) for the full design and protocol.

## Repository layout

- **`app/`** — desktop application: Tauri 2 shell, SvelteKit UI, and the Node.js sidecar backend.
- **`firmware/`** — ESP32-C3 device firmware (PlatformIO + Arduino + FastLED).
- **`tools/`** — ATEM and tally-client simulators for hardware-free development.

## Getting started

**Desktop app** (Tauri 2 + SvelteKit). On NixOS, `flake.nix` provides the whole
toolchain — `direnv allow` (or `nix develop`) to enter the dev shell, then:

```bash
cd app
pnpm install
cargo tauri dev         # build + run the desktop app (spawns the Node sidecar automatically)
```

On other platforms, install the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
(Rust + a WebView) and use `pnpm tauri dev`.

**Firmware** (requires [PlatformIO](https://platformio.org/)):

```bash
cd firmware
pio run                 # build
pio run -t upload       # flash a connected board
pio device monitor      # serial console @ 115200
```

On first boot the device raises a `TallyLight-XXXXXX` WiFi hotspot — connect and
navigate to `192.168.4.1` to enter your network credentials.

## Hardware

- **Board:** ESP32-C3 SuperMini V2 (PlatformIO target `esp32-c3-devkitm-1`)
- **LED:** onboard WS2812 addressable RGB on GPIO8
- **Power:** USB-C from a USB power bank

**Three firmware gotchas:**

1. **GPIO8 is addressable, not digital** — `digitalWrite(8, ...)` does nothing. Always
   drive the LED via FastLED.
2. **Never sleep** — deep/light sleep lets the power bank's auto-off cut power (low-current
   detection). Keep WiFi active.
3. **WiFi TX power** — start at full power; only fall back to `WIFI_POWER_8_5dBm` after
   a failed association attempt (a workaround for older C3 board variants). Never cap it
   unconditionally.

## Docs

| Document | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Protocol spec, network topology, failure modes, packaging |
| [`docs/goals.md`](docs/goals.md) | Product intent, core concepts, decisions |
| [`docs/design.md`](docs/design.md) | UI visual and interaction design |
| [`docs/led.md`](docs/led.md) | LED palette: every device state, colour, and motion |
| [`docs/atem-connection-notes.md`](docs/atem-connection-notes.md) | Sharp edges with the atem-connection library |
| [`docs/packaging-windows.md`](docs/packaging-windows.md) | Building the Windows portable binary |
| [`docs/milestones/v1.1-production-hardening.md`](docs/milestones/v1.1-production-hardening.md) | Active next milestone |
| [`docs/milestones/roadmap.md`](docs/milestones/roadmap.md) | Deferred / future work |

## License

To be added before open-sourcing.

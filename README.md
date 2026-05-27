# TallyBot — WiFi Tally Light System

Wireless camera tally lights for live video production. A desktop app on the
streaming PC reads switcher state from a **Blackmagic ATEM Mini** and sends colour
commands over WiFi to small **ESP32-C3** devices with an RGB LED. Camera operators
see **red** (live), **yellow** (preview), or **green** (idle) at a glance.

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
hardcoded IPs. The only network setup is a DHCP reservation for the streaming PC.
See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design and rationale.

## Repository layout

- **`app/`** — desktop application: Tauri 2 shell, SvelteKit UI, and the Node.js sidecar backend.
- **`firmware/`** — ESP32-C3 device firmware (PlatformIO + Arduino + FastLED).
- **`tools/`** — ATEM and tally-client simulators for hardware-free development.

## Getting started

> Early scaffold: the Tauri app builds; the sidecar and firmware aren't written yet.

**Desktop app** (Tauri 2 + SvelteKit). On NixOS, `flake.nix` provides the whole
toolchain — `direnv allow` (or `nix develop`) to enter the dev shell, then:

```bash
cd app
pnpm install
cargo tauri dev         # build + run the desktop app
```

On other platforms, install the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
(Rust + a WebView) and use `pnpm tauri dev`.

**Firmware** (requires [PlatformIO](https://platformio.org/)) — not yet scaffolded:

```bash
cd firmware
pio run                 # build
pio run -t upload       # flash a connected board
pio device monitor      # serial console
```

## Hardware

- **Board:** ESP32-C3 SuperMini V2 (PlatformIO target `esp32-c3-devkitm-1`)
- **LED:** onboard WS2812 addressable RGB on GPIO8
- **Power:** USB-C from a USB power bank

> ⚠️ Three firmware gotchas — see `CLAUDE.md`: GPIO8 is addressable (not digital),
> never sleep (power banks cut low-current loads), and set a low WiFi TX power as a
> fallback on older C3 boards.

## License

To be added before open-sourcing.

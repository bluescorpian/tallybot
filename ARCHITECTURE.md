# WiFi Tally Light System — Architecture

## What This Is

A wireless camera tally light system for live video production. A desktop application
on the streaming PC reads the active/preview state from a Blackmagic Design ATEM Mini
switcher and broadcasts colour commands to ESP32-based LED devices over WiFi. Camera
operators see red (live), yellow (preview), or green (idle) — the same logic as the
ATEM Mini's own button LEDs.

The project will be open-sourced. All architecture decisions favour simplicity,
reliability on unknown networks, and cross-platform support.

---

## Full Stack

| Layer | Technology |
|---|---|
| Desktop app shell | Tauri |
| Desktop UI | Svelte + TypeScript |
| App backend | Node.js sidecar (TypeScript) |
| ATEM integration | atem-connection npm library |
| Device firmware | PlatformIO + C++ (Arduino framework) |
| LED driver | FastLED |
| WiFi provisioning | SoftAP captive portal via WiFiManager |

---

## Hardware

- Board: ESP32-C3 SuperMini V2. PlatformIO target: esp32-c3-devkitm-1
- MCU: Single-core RISC-V @ 160 MHz, WiFi 802.11 b/g/n + BT5
- RAM / Flash: 400 KB SRAM, 4 MB flash
- LED: Onboard WS2812 RGB addressable LED on GPIO8
- Power: USB-C from a USB power bank

### Critical Firmware Gotchas

1. GPIO8 is addressable, not digital. digitalWrite(8, ...) does nothing and makes the
   board appear dead. Always drive the LED via FastLED or Adafruit NeoPixel.

2. Never sleep. Deep or light sleep causes the power bank's auto-off to cut power
   (low-current detection). Keep the device in active WiFi mode (~80-130 mA average).

3. WiFi TX power fix (older C3 boards): if WiFi won't connect, add
   WiFi.setTxPower(WIFI_POWER_8_5dBm) before WiFi.begin(). V2 supposedly fixed the
   antenna issue, but this is a safe fallback to include.

---

## System Overview

The ATEM Mini connects to the streaming PC over the local network via UDP (port 9910).
The Node.js sidecar inside the Tauri app connects to the ATEM using the atem-connection
library, which implements the reverse-engineered Blackmagic protocol.

The sidecar also runs a TCP server (port 7000) and a UDP discovery listener (port 7001).
ESP32 devices connect to the server over TCP after discovering its IP via UDP broadcast.
The Svelte UI communicates with the sidecar via Tauri's IPC event system.

Data flow: ATEM state change -> Node.js sidecar -> TCP socket -> ESP32 -> WS2812 LED.

---

## Network Protocol

### Known Limitation

Devices and the streaming PC must be on the same subnet. UDP broadcast and direct TCP
do not cross router or VLAN boundaries. This is an accepted constraint — document it
clearly for end users.

---

## Discovery Protocol (UDP, port 7001)

Devices and the server find each other without hardcoded IPs using a combined approach:

- Device broadcasts "TALLY_FIND" to 255.255.255.255:7001 every 2 seconds until connected.
- Server broadcasts "TALLY_HERE:7000" to 255.255.255.255:7001 every 5 seconds.
- Server also unicasts "TALLY_HERE:7000" directly to any device that sends TALLY_FIND.
- Device opens a TCP connection to the IP it received in the reply, then stops broadcasting.

This is startup-order independent: devices keep retrying until the server is reachable,
and the server accepts connections as they arrive.

---

## TCP Connection (port 7000)

Devices connect to the server, not the other way around. The server is the stable
endpoint; devices reconnect automatically on drop.

On connect, the device immediately sends a HELLO message containing its MAC address.
The server maps MAC to socket and uses this to route commands. If the server restarts,
devices detect the closed connection and reconnect, re-sending HELLO.

---

## Binary Message Protocol

All messages are fixed-width. No framing bytes needed — each message type has a known
length.

### Device to Server (7 bytes)

| Byte | Field | Values |
|---|---|---|
| 0 | Message type | 0x01 = HELLO, 0x02 = HEARTBEAT |
| 1-6 | MAC address | 6 bytes, always included |

HELLO is sent immediately on connect and on every reconnect.
HEARTBEAT is sent every 10 seconds. The server resets a 30-second timer per device;
expiry means the connection is considered dead and the socket is closed.

### Server to Device (5 bytes)

| Byte | Field | Values |
|---|---|---|
| 0 | Message type | 0x01 = SET_COLOR, 0x02 = IDENTIFY |
| 1 | R | 0-255 |
| 2 | G | 0-255 |
| 3 | B | 0-255 |
| 4 | Brightness | 0-255 |

SET_COLOR sets the WS2812 LED. IDENTIFY causes the device to flash briefly so the user
can physically locate it during setup (R/G/B/Brightness bytes are ignored for IDENTIFY).

### Standard Colours

| State | R | G | B | Meaning |
|---|---|---|---|---|
| Live | 255 | 0 | 0 | Camera is on Program output |
| Preview | 255 | 180 | 0 | Camera is on Preview |
| Idle | 0 | 255 | 0 | Camera is not selected |
| Disconnected | 0 | 0 | 255 | Device has no server connection |

Brightness default: 128. Configurable per device in the UI.

---

## WiFi Provisioning (SoftAP Captive Portal)

On first boot, or if saved credentials fail to connect:

1. Device creates a WiFi hotspot named TallyLight-XXXXXX (last 6 of MAC).
2. User connects to it from a phone or laptop.
3. A captive portal page opens automatically, or the user navigates to 192.168.4.1.
4. User selects their network and enters the password.
5. Device saves credentials to NVS flash, reboots, and connects.
6. AP mode only activates again if the connection subsequently fails.

Library: WiFiManager (tzapu/WiFiManager on PlatformIO).

---

## Device Identity

Each device is identified by its MAC address, read via WiFi.macAddress() on the ESP32.
The MAC is included in every TCP message from the device. The server stores a mapping
of MAC to camera assignment (e.g. AA:BB:CC:DD:EE:FF -> "Camera 1"), persisted to disk
by the Node.js sidecar so assignments survive app restarts.

---

## ATEM Integration

The Node.js sidecar uses the atem-connection npm library to connect to the ATEM Mini
via UDP (port 9910, reverse-engineered Blackmagic protocol). On each stateChanged event,
the sidecar reads state.video.mixEffects[0].programInput and .previewInput, then sends
the appropriate SET_COLOR command to each connected device based on its ATEM input
assignment.

The ATEM's IP is entered once in app settings. DHCP reservation is recommended.

### Why Not the Official Blackmagic SDK

The official SDK is COM-based (Windows Component Object Model), meaning it only works
on Windows and macOS, requires ATEM Software Control to be installed, and produces
unidiomatic C# via COM interop. atem-connection is cross-platform, has no install
dependency, and is significantly more actively maintained.

### Why Not the Videohub TCP Protocol (port 9990)

The Videohub protocol is a simple text-based TCP interface that exposes program/preview
routing — sufficient for tally alone, but read-only. It cannot be used to control the
switcher. Rejected in favour of atem-connection which enables full control for the
future roadmap.

---

## Project File Structure

At a high level the repo has three top-level areas:

- `app/` — the Tauri 2 desktop application: a SvelteKit UI, a minimal Rust shell
  (`src-tauri/`), and the Node.js sidecar backend (`sidecar/`).
- `firmware/` — the ESP32-C3 device firmware (PlatformIO + Arduino).
- `tools/` — ATEM and tally-client simulators for hardware-free development.

This document describes the design, not a file-by-file snapshot. Explore the
directories for the current layout — it changes as the project grows.

---

## Key Dependencies

Firmware (platformio.ini):
```
lib_deps =
    fastled/FastLED
    tzapu/WiFiManager
```

Node.js sidecar:
```
atem-connection (npm)
```

TCP and UDP networking use Node.js built-in modules (net, dgram) — no third-party
networking libraries.

---

## Roadmap (Not Yet Designed)

- Web UI accessible from other devices on the network
- Multi-switcher support
- Per-device brightness and colour customisation in UI
- Tauri sidecar IPC event schema (to be designed once repo is scaffolded)

### OBS Integration (obs-websocket)

When OBS is the streaming application, a scene change in OBS can render ATEM tally
meaningless — if OBS switches away from the scene containing the ATEM feed, all cameras
are effectively off-air regardless of what the ATEM is doing.

The proposed integration connects the sidecar to OBS via obs-websocket and monitors the
active scene. When OBS is on a scene that does not contain the ATEM feed, the sidecar
overrides all device colours to Idle. When OBS is back on the ATEM scene, normal tally
resumes.

**Open question — tally authority when OBS is on the ATEM scene:**
Current thinking is that ATEM always drives individual camera tally state, and OBS only
contributes a global "all idle" override. The alternative — OBS taking full control of
per-camera tally when it is on an ATEM scene — would require OBS to expose per-input
tally data, which it does not. The ATEM-drives-cameras / OBS-drives-override split is
therefore both the simpler model and the only practical one. This should be confirmed
and locked down before implementation.

### ATEM and Tally Client Simulators

To allow development and testing without physical hardware:

- **ATEM simulator:** a stub of the atem-connection library, exposing the same API but with hardcoded or configurable state. This allows the sidecar and UI to be developed and tested without an actual ATEM switcher. it should include controls for changing program/preview state to verify the full data flow.
- **Tally client simulator:** a script that connects to the sidecar's TCP server,
  sends a HELLO with a configurable fake MAC address, and logs incoming SET_COLOR
  commands to the terminal. Allows the full server-side path to be verified without
  ESP32 hardware.

Both simulators should live in a /tools directory in the repo.

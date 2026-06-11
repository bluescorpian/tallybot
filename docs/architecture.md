# WiFi Tally Light System — Architecture

## What This Is

A wireless camera tally light system for live video production. A desktop application
on the streaming PC reads the active/preview state from a Blackmagic Design ATEM Mini
switcher and broadcasts colour commands to ESP32-based LED devices over WiFi. Camera
operators see red (live), green (preview), or dim white (idle) — matching the
ATEM Mini's own button LED conventions.

The project will be open-sourced. All architecture decisions favour simplicity,
reliability on unknown networks, and cross-platform support.

**Related docs:** [`docs/goals.md`](goals.md) holds the product intent and decisions,
[`docs/design.md`](design.md) the UI design. This document is the source of truth for
the network/binary protocol and the rationale.

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

1. GPIO8 is addressable, not digital. `digitalWrite(8, ...)` does nothing and makes the
   board appear dead. Always drive the LED via FastLED or Adafruit NeoPixel.

2. Never sleep. Deep or light sleep causes the power bank's auto-off to cut power
   (low-current detection). Keep the device in active WiFi mode (~80–130 mA average).

3. WiFi TX power: run at full power (`WIFI_POWER_19_5dBm`) and never cap it. Capping slashes
   uplink range on venue APs.

---

## System Overview

The ATEM Mini connects to the streaming PC over the local network via UDP (port 9910).
The Node.js sidecar inside the Tauri app connects to the ATEM using the atem-connection
library, which implements the reverse-engineered Blackmagic protocol.

The sidecar also runs a TCP server (port 7000) and a UDP discovery listener (port 7001).
ESP32 devices connect to the server over TCP after discovering its IP via UDP broadcast.
The Svelte UI communicates with the sidecar via Tauri's IPC event system.

Data flow: ATEM state change → Node.js sidecar → TCP socket → ESP32 → WS2812 LED.

Devices provisioned for **ESP-NOW** (v1.3) bypass the network entirely: a USB-connected
device the app designates as a **bridge** relays commands between the sidecar (over the
USB-CDC channel, RELAY-wrapped) and nearby lights (over ESP-NOW, Espressif's peer-to-peer
MAC-layer protocol — no AP, router, or network required). Data flow on that path:
ATEM state change → sidecar → USB (RELAY) → bridge → ESP-NOW → ESP32 → WS2812 LED.
The full design is in [`docs/spec/esp-now-transport.md`](spec/esp-now-transport.md).

---

## Network Protocol

### Known Limitation

Devices and the streaming PC must be on the same subnet. UDP broadcast and direct TCP
do not cross router or VLAN boundaries. This is an accepted constraint — document it
clearly for end users. (The v1.3 ESP-NOW transport sidesteps the network — and this
limitation — entirely for venues where no usable WiFi exists.)

---

## Discovery Protocol (UDP, port 7001)

Devices and the server find each other without hardcoded IPs using a combined approach:

- Device broadcasts "TALLY_FIND" to 255.255.255.255:7001 every 2 seconds until connected.
- Server broadcasts "TALLY_HERE:7000" to 255.255.255.255:7001 every 5 seconds.
- Server also unicasts "TALLY_HERE:7000" directly to any device that sends TALLY_FIND.
- Device opens a TCP connection to the IP it received in the reply, then stops broadcasting.

This is startup-order independent: devices keep retrying until the server is reachable,
and the server accepts connections as they arrive.

**ESP-NOW discovery mirrors this one layer down** (v1.3): a light broadcasts the same
`TALLY_FIND` string to the ESP-NOW broadcast MAC (`ff:ff:ff:ff:ff:ff`) every 2 seconds; the
bridge registers the sender as a peer and unicasts the same `TALLY_HERE:7000` reply (the
port is meaningless over ESP-NOW and ignored — one reply format on both transports). The
light then sends HELLO through the bridge and rides SET_COLOR exactly as a TCP device does.

---

## TCP Connection (port 7000)

Devices connect to the server, not the other way around. The server is the stable
endpoint; devices reconnect automatically on drop.

On connect, the device immediately sends a HELLO message containing its MAC address and
the protocol version it speaks. The server maps the socket to that MAC (and records the
version) and uses the socket to route commands for the rest of the session. If the server
restarts, devices detect the closed connection and reconnect, re-sending HELLO.

---

## Binary Message Protocol

### Framing

Every message is length-prefixed: a single leading byte gives the number of payload bytes
that follow.

```
[len][payload …]      len = count of payload bytes that follow (1 byte, 0-255)
```

The receiver reads one length byte, reads that many bytes, then dispatches on the first
payload byte (the message type). One uniform loop frames any message regardless of its
length, and a parser can skip a message — or trailing fields — it doesn't recognise, which
is what makes forward/backward compatibility possible (see Versioning below). TCP is a
byte stream with no inherent message boundaries, so some framing rule is required;
length-prefixing is the simplest one that also tolerates change.

### Device to Server

| Message | Type | Payload (follows `len`) | On the wire |
|---|---|---|---|
| HELLO | 0x01 | `[type][version][MAC×6]` | 9 bytes |
| HEARTBEAT | 0x02 | `[type]` | 2 bytes |

(USB adds STATUS `0x03`, LOG `0x04`, and the bridge's device→host RELAY envelope `0x06`
`[type][srcMAC×6][inner…]`; see [`docs/spec/usb-serial-protocol.md`](spec/usb-serial-protocol.md)
and [`docs/spec/esp-now-transport.md`](spec/esp-now-transport.md) for those tables.)

HELLO is sent immediately on connect and on every reconnect; it carries the device's MAC
and the protocol version it speaks. HEARTBEAT is sent every 10 seconds and carries no MAC
— the server already knows which device a connection belongs to from its HELLO (the TCP
socket is the identity for the rest of the session). The server resets a 30-second timer
per device on each heartbeat; expiry means the connection is considered dead and the
socket is closed.

### Server to Device

| Message | Type | Payload (follows `len`) | On the wire |
|---|---|---|---|
| SET_COLOR | 0x01 | `[type][R][G][B][brightness]` | 6 bytes |

SET_COLOR sets the WS2812 LED (R/G/B and brightness each 0-255). Type `0x02` is retired:
it was IDENTIFY, a one-shot "flash to locate" the device drew itself. Locating is now a
server concern — to flash a device the sidecar streams a white/off SET_COLOR burst (see the
locate strobe in `app.ts`), so the firmware stays dumb and only ever renders the colours it's
sent.

(USB adds SET_WIFI `0x03`, SET_TRANSPORT `0x04` — `[type][mode]`, or `[type][mode][channel]`
for ESP-NOW mode 2 — GET_STATUS `0x05`, the host→bridge RELAY envelope `0x07`
`[type][targetMAC×6][inner…]`, and SET_BRIDGE `0x08` `[type][enabled][channel]`; tables in
the [USB](spec/usb-serial-protocol.md) and [ESP-NOW](spec/esp-now-transport.md) specs. An
ESP-NOW light receives the same `[type][fields…]` payloads as one raw datagram each — no
framing; the envelope is stripped by the bridge.)

**SET_COLOR is idempotent state, not a one-shot event.** The sidecar re-asserts every
connected device's current colour on a ~1 s keyframe tick (in addition to sending on change),
so a packet lost in flight self-heals on the next tick and a device that power-cycles or drifts
into range mid-show recovers within a tick. The re-send is uniform across all transports: TCP
and USB-CDC guarantee delivery and don't strictly need it, but the cost is trivial (~6 payload
bytes × devices/s) and uniformity keeps the firmware a dumb state-renderer that never has to know
its transport's reliability — the safeguard that makes the v1.3 fire-and-forget ESP-NOW path
trustworthy. So expect a steady, assigned device to receive a repeating SET_COLOR at ~1 Hz on a
packet capture; that is the keyframe, not a bug. Animated states (the fault flash, the unassigned
breathe) re-send far faster as the server streams their frames.

**Brightness is a *perceptual* value, and the device linearizes it.** The byte is "how
bright it should look," not a raw PWM/drive level — so equal steps in the byte (and in the
UI's 0–10 levels, which map to it linearly: level 5 ≈ the default 128) should *appear*
evenly spaced. WS2812 output and the human eye are both non-linear, so the **firmware**
applies a **gamma correction** when driving the LED (FastLED ships this — a gamma LUT, or
`dim8_video` / `applyGamma_video`, applied to the brightness before it reaches the strip).

Owning the correction at the device — not the UI or sidecar — is deliberate: it keeps the
wire byte device-independent (a future unit with a different LED corrects for *its own*
response without a protocol or app change), avoids every client re-implementing the curve,
and removes any risk of double-correction. The sidecar (`encodeSetColor`) therefore passes
the byte through unmodified, and the UI's level↔byte mapping stays linear.

### Versioning

HELLO carries the protocol version the device speaks. The server defines two constants:
`CURRENT` (the version it prefers) and `MIN_SUPPORTED` (the oldest it still handles).

- If the device's version is between `MIN_SUPPORTED` and `CURRENT`, the server records it
  per connection and **speaks that device's dialect** — devices never have to match the
  server exactly, and never *have* to be re-flashed to keep working.
- If the device is older than `MIN_SUPPORTED`, the server surfaces a clear "update
  firmware" warning instead of misbehaving silently.

Backward-compatibility lives in the **server** (easy to update), not the **firmware**
(flashed onto physical devices). Raising `MIN_SUPPORTED` is how very old versions are
eventually retired.

History: `CURRENT` went 1 → 2 for USB provisioning (v1.2: SET_WIFI/SET_TRANSPORT/STATUS),
then 2 → 3 for ESP-NOW (v1.3: SET_TRANSPORT mode 2 + channel, SET_BRIDGE, the RELAY
envelopes, STATUS's trailing `[channel][bridging]` bytes). The app only offers ESP-NOW
provisioning and bridge designation to devices reporting ≥ 3. `MIN_SUPPORTED` remains 1.

### Standard Colours

See [`docs/led.md`](led.md) for the full LED palette, state definitions, and the design
rules behind the colour assignments. The tally colours (red/green/dim-white/flashing-blue)
are specified there alongside all device-local states.

Brightness default: 128 (≈ the perceptual midpoint, UI level 5). Configurable per device in
the UI; it's a perceptual value the device gamma-corrects (see SET_COLOR above).

### Failure signalling

A tally light's most dangerous failure is a **false "clear"**: if it goes dim white
when the truth is unknown, an operator reads "you're off air" and relaxes — possibly while
live. So idle (dim white) is only ever shown when the sidecar genuinely knows the input is *not*
selected. When it **can't trust the source**, an assigned device shows the **Fault** state —
**flashing blue** — never idle.

The source is untrusted when:

- the ATEM is **disconnected or reconnecting** (we hold no live program/preview), or
- the ATEM is connected but **hasn't reported a program input yet** (state we haven't
  actually received can't be asserted as "not live").

We deliberately do *not* infer staleness from the gap between `stateChanged` events: a quiet
but perfectly healthy switcher can send nothing for minutes, and a fault that cries wolf
during a calm show is worse than the bug it guards against. Detecting a silently-dead link is
`atem-connection`'s job — its keepalive turns one into a `disconnected` event, which the
above already covers.

**Two blues, one meaning — "don't trust this light":**

- **Steady blue** is *device-local*. The firmware shows it on its own when it loses the
  server (no commands arriving). The server can't send this, by definition — if it can reach
  a device, that link is up.
- **Flashing blue** is *server-driven*. The server is reaching the device fine, but the
  **source** behind it is down. The flash distinguishes this active, server-known fault from
  a device that has gone quietly dark, and from a steady tally colour.

Either way the operator's takeaway is identical: this light is not telling you your real
state. The UI also greys the source out and shows each input as *unknown* rather than idle.
An **unassigned** connected device is unaffected — with no input bound there is no tally to
get wrong, so it keeps the setup colour.

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
The MAC is included in every TCP message from the device. The server stores a mapping of
**MAC → assigned ATEM input** (e.g. AA:BB:CC:DD:EE:FF → input 1), persisted to disk by
the Node.js sidecar so assignments survive app restarts.

This is the **STA-interface** MAC, and ESP-NOW deliberately runs on the STA interface
(v1.3): ESP-NOW addresses peers by MAC, so the address a bridge relays to is byte-identical
to the identity the sidecar already maps — one MAC, every transport.

Devices have **no user-given name**: a device is identified by its MAC (shown as a short
tail in the UI) and located physically with a flash (the locate strobe). Human-readable labels come
from the **input** — the ATEM's own input names — not from the device. See
[`docs/goals.md`](goals.md) for the rationale.

---

## ATEM Integration

The Node.js sidecar uses the atem-connection npm library to connect to the ATEM Mini
via UDP (port 9910, reverse-engineered Blackmagic protocol). On each stateChanged event,
the sidecar reads state.video.mixEffects[0].programInput and .previewInput, then sends
the appropriate SET_COLOR command to each connected device based on its ATEM input
assignment.

From `state.inputs` the sidecar exposes only the **camera inputs** — input ids `1`–`999` —
and takes each input's label from its `longName`. The ATEM's internal sources (black at
`0`; colour bars, media players, ME outputs and the like at `≥ 1000`) are filtered out, so
the UI's input row matches the physical switcher rather than listing routing internals.

The ATEM's IP is entered once in app settings, and is persisted alongside the device
assignments so it is reused on the next launch. DHCP reservation is recommended.

For sharp edges and gotchas with the atem-connection library, see
[`docs/atem-connection-notes.md`](atem-connection-notes.md).

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

## Packaging the Sidecar

The sidecar ships as a single self-contained binary built with
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) and spawned by the Rust shell as a
Tauri `externalBin`. The build (`app/sidecar/build.mjs`, run by `beforeBuildCommand`)
esbuild-bundles `src/main.ts` with **`atem-connection` left external** so its
runtime-loaded worker file survives into the pkg snapshot, then packs that bundle + the
Node runtime into one executable named for the Rust target triple.

The key constraint: `atem-connection` must stay external (not bundled) so its
`atemSocketChild` worker is traceable by pkg. Library `console.log`/`info`/`debug` output
is redirected to stderr in `main.ts` before any `Atem` is constructed, keeping the NDJSON
stdout stream clean for Tauri IPC. Everything else — multithreaded `Atem`, native deps,
pkg bytecode — works with no workarounds. Build per target on its own OS; native deps and
bytecode are not cross-platform.

### Building a release

```bash
cd app/sidecar && pnpm install        # once: installs esbuild + @yao-pkg/pkg
cd app && pnpm install                # once: frontend deps
cd app && cargo tauri build           # beforeBuildCommand builds the sidecar binary,
                                       # then Tauri bundles it as the externalBin
```

`beforeBuildCommand` runs `pnpm -C sidecar run build:binary` (→ `build.mjs`), which
emits `app/src-tauri/binaries/tallybot-sidecar-<triple>[.exe]` for the host triple.
That file is a **git-ignored build artifact** (~90 MB) — never commit it. For the
no-installer portable distribution, take the built executable plus its sidecar binary
from `target/release/` and zip them; config survives updates because the sidecar writes
to the OS app-data dir (`TALLYBOT_STATE_FILE`, set by the Rust shell).

For Windows-specific steps, see [`docs/packaging-windows.md`](packaging-windows.md).

> NixOS note: pkg can't exec its fetched base-node to generate V8 bytecode, so
> `build.mjs` detects `/etc/NIXOS` and passes `--fallback-to-source` (ships plain JS —
> correct, just larger). Windows/macOS/other-Linux builds produce real bytecode.

---

## Simulators and dev tools

See [`tools/README.md`](../tools/README.md) for the ATEM simulator, tally-client
simulator, `sidecar-dev` REPL, and the end-to-end test harness.

---

## Roadmap

Future work is tracked in [`docs/milestones/roadmap.md`](milestones/roadmap.md).

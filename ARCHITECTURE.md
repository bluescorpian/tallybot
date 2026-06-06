# WiFi Tally Light System — Architecture

## What This Is

A wireless camera tally light system for live video production. A desktop application
on the streaming PC reads the active/preview state from a Blackmagic Design ATEM Mini
switcher and broadcasts colour commands to ESP32-based LED devices over WiFi. Camera
operators see red (live), green (preview), or dim white (idle) — matching the
ATEM Mini's own button LED conventions.

The project will be open-sourced. All architecture decisions favour simplicity,
reliability on unknown networks, and cross-platform support.

**Related docs:** `GOALS.md` holds the product intent and decisions, `DESIGN.md` the UI
design, and `PHASES.md` the build phases. This document is the source of truth for the
network/binary protocol and the rationale — keep it consistent with `GOALS.md`.

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
| IDENTIFY | 0x02 | `[type]` | 2 bytes |

SET_COLOR sets the WS2812 LED (R/G/B and brightness each 0-255). IDENTIFY causes the
device to flash briefly so the user can physically locate it during setup.

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

### Standard Colours

| State | R | G | B | Driven by | Meaning |
|---|---|---|---|---|---|
| Live | 255 | 0 | 0 | server | Input is on Program output |
| Preview | 0 | 255 | 0 | server | Input is on Preview |
| Idle | 30 | 30 | 30 | server | Input is not selected *and the source is trustworthy* (dim white) |
| Fault | 0 | 0 | 255 | server | **Flashing.** Source state can't be trusted (see below) |
| Disconnected | 0 | 0 | 255 | device | **Steady.** The device itself has lost the server |
| Setup | 255 | 0 | 255 | server | Connected but not yet assigned to an input (`GOALS.md`; provisional) |

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
get wrong, so it keeps the steady setup colour.

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
**MAC -> assigned ATEM input** (e.g. AA:BB:CC:DD:EE:FF -> input 1), persisted to disk by
the Node.js sidecar so assignments survive app restarts.

Devices have **no user-given name**: a device is identified by its MAC (shown as a short
tail in the UI) and located physically with IDENTIFY (a flash). Human-readable labels come
from the **input** — the ATEM's own input names — not from the device, and there is no
separate "camera" entity. See `GOALS.md` for the rationale.

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

## Packaging the Sidecar

**Decision (Phase 5, proven empirically):** the sidecar ships as a single
self-contained binary built with [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg)
(the maintained vercel/pkg fork) and spawned by the Rust shell as a Tauri
`externalBin`. The build is `app/sidecar/build.mjs` (run by `beforeBuildCommand`):
esbuild bundles `src/main.ts` to one CJS file with **`atem-connection` left
external**, then pkg packs that bundle + the Node runtime + the still-on-disk
`atem-connection` (worker included) into one executable named for the Rust target
triple. No host Node is required on the user's machine.

This contradicts the earlier assumption that single-binary was "impractical" — it was
verified three ways (isolated repro, standalone sidecar, and the real Tauri app), and
the multithreaded `threadedClass`/`atemSocketChild` worker does live UDP I/O from
inside pkg's `/snapshot/` FS. **None of the historical workarounds were needed**: no
`@julusian/freetype2` stub, no manual `atemSocketChild.js` copy, no
`disableMultithreaded`. See the corrected warnings below for why each turned out not
to bite.

### The warnings (and how each actually played out)

These were learned building `tools/atem-probe` (a standalone field-test tool that
packages just the ATEM read-path) and are properties of `atem-connection` itself, so
they're worth keeping — but the single-binary verdicts have been corrected against the
proven recipe above.

1. **`atem-connection` assumes its files live on disk in `node_modules`.** It loads a
   native module *and* loads its UDP-socket worker (`atemSocketChild`) by file *path* at
   runtime (via `threadedclass`) — neither survives being collapsed into one bundled
   file. The fix is simply to **not bundle the library**: keep `atem-connection`
   external in the esbuild step so its files stay on disk, and let pkg trace them into
   the snapshot. Verified: `atemSocketChild.js` ends up embedded in the binary and the
   worker runs. (The probe's alternative — ship JS + `node_modules` + a Node runtime —
   also works, but the single binary is simpler to distribute and was chosen.)

2. **Library code writes to `stdout` — which the IPC bridge owns. (Fixed.)**
   `threadedclass` logs via `console.log`/`info`/`debug`. The sidecar's NDJSON IPC also
   writes to `process.stdout` (`ipc-bridge.ts`), and one stray library line would corrupt
   the framing the UI parses. **Fixed in `sidecar/src/main.ts`:** before any `Atem` is
   constructed, `console.log`/`info`/`debug` are redirected to stderr (`console.warn`/
   `error` already go there). Verified in the packaged binary — all library logging lands
   on stderr, the NDJSON stream stays clean.

3. **The default `new Atem()` is multithreaded — it runs the socket off the main thread**
   (a `worker_threads` worker), loading `atemSocketChild` **by path** at runtime via
   `threadedclass`. The concern was that a packed binary or restricted sandbox would break
   that spawn/require. **It doesn't:** the default multithreaded `Atem` packs cleanly and
   does live UDP I/O from inside the pkg snapshot, so production keeps the default and its
   event-loop isolation + freeze-watchdog. `disableMultithreaded` was considered and
   proved **unnecessary**. The library's other runtime sharp edges (lifecycle/leak-safety)
   are in [`ATEM-CONNECTION-NOTES.md`](ATEM-CONNECTION-NOTES.md) (§1).

4. **Native modules are per-platform *and* per-ABI.** `@julusian/freetype2` ships prebuilt
   binaries keyed by `platform-arch-napiVersion`. Because `atem-connection` is left
   external, pkg traces freetype2's `node_modules` into the snapshot — and freetype2
   bundles prebuilds for *all* platforms in its npm tarball, so a tree installed on Linux
   still carries the Windows/macOS binaries. (We never call freetype2 — multiviewer-label
   rendering only — so even a missing prebuild wouldn't matter, but they're present.) Don't
   assume every native dep is so generous; **build per target on its own OS** to be safe.
   `build.mjs` names output for the host triple, so the Windows binary is built on Windows.

5. **Running TypeScript at runtime is a Node-version dependency. (Resolved for the
   binary.)** Standalone/dev runs `.ts` directly via Node's type stripping
   (`--experimental-strip-types`). The shipped binary sidesteps this entirely: esbuild
   compiles the TS to JS and pkg embeds a pinned Node runtime, so there's no dependency on
   the host's Node at all.

### Building a release

The sidecar binary is **per-OS** — build it on the platform you're shipping to (pkg
can cross-compile the Node runtime, but native deps and bytecode are safest built
natively). On a clean checkout:

```bash
cd app/sidecar && pnpm install        # once: installs esbuild + @yao-pkg/pkg
cd app && pnpm install                # once: frontend deps
cd app && cargo tauri build           # beforeBuildCommand builds the sidecar binary,
                                       # then Tauri bundles it as the externalBin
```

`beforeBuildCommand` runs `pnpm -C sidecar run build:binary` (→ `build.mjs`), which
emits `app/src-tauri/binaries/tallybot-sidecar-<triple>[.exe]` for the host triple.
That file is a **git-ignored build artifact** (~90 MB) — never commit it. For the
no-installer portable distribution we want, take the built executable plus its
sidecar binary from `target/release/` (skip the `.msi`/`.deb` bundles) and zip them;
the user unzips and runs in place, and config survives updates because the sidecar
writes to the OS app-data dir (`TALLYBOT_STATE_FILE`, set by the Rust shell).

> NixOS note: pkg can't exec its fetched base-node to generate V8 bytecode, so
> `build.mjs` detects `/etc/NIXOS` and passes `--fallback-to-source` (ships plain JS —
> correct, just larger). Windows/macOS/other-Linux builds produce real bytecode.

---

## Roadmap (Not Yet Designed)

- Web UI accessible from other devices on the network
- Multi-switcher support
- Per-device colour/appearance customisation in UI (per-device brightness is already v1)
- Non-ATEM input sources (e.g. OBS as a switcher) — a deferred refactor; see `GOALS.md`

The **Tauri sidecar IPC event schema** is no longer an open design question: its shape is
now determined by `GOALS.md` (device / input / source / program-gate), and writing it is
the Phase 0 deliverable (see `PHASES.md`).

### OBS Integration (obs-websocket)

When OBS is the streaming application, a scene change in OBS can render ATEM tally
meaningless — if OBS switches away from the scene containing the ATEM feed, all cameras
are effectively off-air regardless of what the ATEM is doing.

The proposed integration connects the sidecar to OBS via obs-websocket and monitors the
active scene. When OBS is on a scene that does not contain the ATEM feed, the sidecar
overrides all device colours to Idle. When OBS is back on the ATEM scene, normal tally
resumes.

**Decided — tally authority:** the **ATEM always drives per-input tally**; OBS contributes
only a global **program-gate override** that forces every device to Idle when its active
scene does not contain the ATEM feed. (OBS taking full per-camera control would require
per-input tally data it does not expose.) The program-gate is modelled in the IPC schema
from v1 — present but inactive until an override source is configured — so adding OBS *as
an override* is cheap. OBS *as an input source* (switching cameras in OBS instead of on
the ATEM) is a separate, deferred refactor. See `GOALS.md`.

### ATEM and Tally Client Simulators

To allow development and testing without physical hardware:

- **ATEM simulator:** a stub of the atem-connection library, exposing the same API but with hardcoded or configurable state. This allows the sidecar and UI to be developed and tested without an actual ATEM switcher. it should include controls for changing program/preview state to verify the full data flow.
- **Tally client simulator:** a script that connects to the sidecar's TCP server,
  sends a HELLO with a configurable fake MAC address, and logs incoming SET_COLOR
  commands to the terminal. Allows the full server-side path to be verified without
  ESP32 hardware.

Both simulators should live in a /tools directory in the repo.

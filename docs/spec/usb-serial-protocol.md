# Spec: USB-serial onboarding protocol (provisioning + LED)

Pre-implementation design for the USB-serial control protocol behind milestone
[`v1.2 — Zero-Friction Onboarding`](../milestones/v1.2-zero-friction-onboarding.md).

Scope: what the app and a **running TallyBot firmware** say to each other over the
USB-C cable — provisioning (WiFi creds + transport mode) and live LED/tally commands —
and what happens to the firmware's existing serial logging. **Out of scope:** the
flashing step's wire protocol (Espressif's download protocol, handled by a library —
see [Flashing](#flashing)).

---

## Decisions at a glance

These are the settled choices (the reasoning for each is in its section):

| Concern | Decision | Piggyback on |
|---|---|---|
| **Framing (USB)** | COBS — self-synchronizing, one scheme for the whole pipe | `PacketSerial` (firmware) + a COBS crate (host) |
| **Logs vs. binary on one pipe** | **Frame everything.** Logs become `LOG` frames; no raw text, no mode-switch | — |
| **Provisioning** | **Native messages** in our own protocol (`SET_WIFI`, `SCAN_WIFI`, reuse `STATUS`/`LOG`). **Not** Improv | — |
| **Message payloads** | Shared with the existing TCP protocol; only the framing differs | existing `protocol.ts` / `protocol.h` |
| **Flashing** | `espflash` as a Rust crate in the Tauri shell; ship a prebuilt `.bin` | `esp-rs/espflash` |
| **Host serial library** | **Rust `serialport-rs`**, in the Tauri shell process on a dedicated thread (no separate process). See [Host architecture](#host-side-architecture) | `serialport-rs` |

**Rejected:** the browser-delegated flow (ESP Web Tools / hosted web flasher) — the
"all from inside the app" differentiator makes a browser hop unacceptable. **Improv Wi-Fi
Serial** — its only unique value is interop with third-party provisioning tools, which we
don't want; it would also add a *second* framing scheme (its `IMPROV` magic header)
alongside COBS on one pipe. With both ends ours, native messages are simpler and consistent.

---

## The central decision: what happens to existing serial logging?

The board has **one** USB-CDC pipe (native USB Serial/JTAG, `ARDUINO_USB_CDC_ON_BOOT=1`).
Today it carries 22 human-readable `Serial.print` diagnostic lines. The control protocol is
binary. **These cannot be naively interleaved** — a text byte read as a frame boundary
corrupts the stream.

**Decision: frame everything.** Every byte on the pipe is a COBS frame, *including logs*
(a `LOG` message type). There is no raw text on the wire and no stateful "text mode → binary
mode" switch (an earlier draft used a `PROBE`/handshake mode-switch; it's dropped — research
flags mode-switching as the same fragile failure mode as the framing it tries to avoid).

This dissolves the coexistence problem entirely: logs and control are both self-describing
frames the host demuxes by type byte. Diagnostics aren't lost — they're an *upgrade*: the app
forwards `LOG` frames to its diagnostics view, giving a live device-log channel over USB that
directly attacks the deferred WiFi-join problem
([`docs/wifi-troubleshooting.md`](../wifi-troubleshooting.md)).

**Dev affordance.** A `TALLYBOT_USB_TEXT_LOG` build flag (default **on** in dev builds, off in
release) makes the firmware emit plain `Serial.print` text instead of `LOG` frames, so
`pio device monitor` and `esp32_exception_decoder` keep working unchanged for firmware devs.
Release firmware frames everything; a small `tools/usb-monitor` decoder pretty-prints frames
for humans. Boot/panic backtraces emitted by ROM (not our code) are unavoidable raw text —
**COBS handles this for free**: the host's decoder resyncs on the next `0x00` delimiter and
loses at most the corrupted frame.

---

## Framing: COBS via PacketSerial

USB framing is **COBS** (Consistent Overhead Byte Stuffing): the payload is encoded so the
byte `0x00` never appears inside it, and a lone `0x00` is an unambiguous frame delimiter.
After any corruption the receiver scans to the next `0x00` and is **guaranteed** re-aligned —
the self-synchronizing property plain length-prefix framing lacks. Overhead is bounded at
≤0.4% (`⌈n/254⌉` bytes).

- **Firmware:** `PacketSerial` (bakercp) in COBS mode wraps the existing `Serial`. It does
  framing only; our `[type][fields…]` payload rides inside each frame.
- **Host:** a COBS decode crate (`corncobs`/`cobs` in Rust, `cobs` in Node) plus a one-byte
  type dispatch.
- **No CRC.** Native USB-CDC already has a link-layer CRC16 + retransmit, so an app-layer
  checksum is redundant here. (Revisit only if a USB-UART bridge or an ESP-NOW path ever
  reuses this framing — neither is native USB.)

**TCP is untouched.** The existing TCP transport keeps its length-prefix `[len][payload]`
framing and `FrameDecoder`. **Framing is transport-specific; message payloads are shared.**
Only the wrapper differs (TCP length-prefix today; USB COBS); the `[type][fields…]` schemas
below are identical on both transports.

---

## Message types

Direction-scoped type bytes, as today. **Existing payloads are unchanged**; new ones are
additive. Each row is the COBS frame payload (`[type]` is the first byte).

### Device → host (extends the existing Device→Server set)

| Message | Type | Payload | Notes |
|---|---|---|---|
| HELLO | `0x01` | `[type][version][MAC×6]` | **Unchanged.** Emitted on USB connect (and repeated ~1 s until a host message arrives — the discovery-retry pattern). How the app learns the MAC and that TallyBot firmware (not a bare board) is running. |
| HEARTBEAT | `0x02` | `[type]` | **Unchanged**, but **unused over USB** — port-close is the liveness/disconnect signal. |
| STATUS | `0x03` | `[type][transport][wifiState][rssi][ssidLen][ssid…]` | transport: 0=No-TX, 1=WiFi. wifiState enum {idle, joining, connected, failed}. rssi signed byte (0 if N/A). `ssid` is the device's **NVS SSID** (`ssidLen=0` → no creds), so the host adopts it as truth rather than relying on its own memory — and it supersedes the old `credsPresent` bool (`ssidLen>0` carries that signal). Reply to `GET_STATUS`; **streamed on change** while a host is cabled (wifiState/rssi/ssid/transport), throttled, gated on a connected host. |
| LOG | `0x04` | `[type][level][utf8…]` | level 0=info,1=warn,2=error. Replaces raw `Serial.print` in release builds. |
| SCAN_RESULT | `0x05` | `[type][count] then count × [rssi][ssidLen][ssid…]` | Reply to `SCAN_WIFI`. **Deferred post-v1.2** (type byte reserved); the user types the SSID in v1.2. |

### Host → device (extends the existing Server→Device set)

| Message | Type | Payload | Notes |
|---|---|---|---|
| SET_COLOR | `0x01` | `[type][R][G][B][brightness]` | **Unchanged.** Byte-identical to TCP — same palette, same server-driven flash/breathe frames, device still gamma-corrects. |
| IDENTIFY | `0x02` | `[type]` | **Unchanged.** |
| SET_WIFI | `0x03` | `[type][ssidLen][ssid…][passLen][pass…]` | **Save-only.** Persist creds to the **existing WiFi NVS** WiFiManager reads (captive-portal fallback + saved-creds path stay intact) and persist `transport=WiFi`, then emit `STATUS` at once. The confirm never gates on the join; the background association streams as non-gating `wifiState` (below). |
| SET_TRANSPORT | `0x04` | `[type][mode]` | mode 0=No-TX (USB-only), 1=WiFi. Persist to NVS. |
| GET_STATUS | `0x05` | `[type]` | Request a `STATUS` frame. |
| SCAN_WIFI | `0x06` | `[type]` | Request a WiFi scan → `SCAN_RESULT`. **Deferred post-v1.2** (type byte reserved). |

### Provisioning is save-only (no live join)

`SET_WIFI` **persists** the creds (and `transport=WiFi`) and the device confirms immediately —
`STATUS(transport=WiFi, ssid=…, wifiState=joining)` — and **never gates or waits on** the join
result. The creds apply when the device is unplugged and deployed.

> **Why not validate the join first?** An earlier draft *gated provisioning* on a cabled join so the
> wizard would confirm "Joined ✓ (RSSI −60)" before letting the operator unplug. Field-testing
> reversed that gate: it forced the operator to provision *in range* of the target AP, and the
> ESP32-C3 emits transient auth-style disconnects (reason 2/15) on the first attempt that surfaced as
> instant **false** "auth failed" verdicts on a correct password.
>
> Provisioning is therefore **save-only and non-blocking** — confirming the save never depends on a
> join result. But the background association `SET_WIFI` kicks off *is* now surfaced as **live,
> non-gating** `wifiState` over the streamed `STATUS`: `joining` → `connected` (+ RSSI) or, only for a
> *settled, pre-association auth failure* (reasons 2/15/202/204) **after a debounce window**,
> `failed`. The debounce steps past the C3 transient, and out-of-range (reasons 200/201) stays
> `joining` — so a good password is never shown as a failure and provisioning still works from
> anywhere. Deeper signal confirmation at the deploy spot still lives on the SoftAP diagnostics panel
> (BOOT-hold) and any future `SCAN_WIFI`.

---

## Versioning

Bump `PROTOCOL_VERSION.CURRENT` 1 → **2**; keep `MIN_SUPPORTED = 1`.

- A v2 HELLO tells the app the firmware understands provisioning frames; the app only sends
  `SET_WIFI`/`SET_TRANSPORT` to a device reporting version ≥ 2.
- Pre-USB (v1) devices keep working over TCP untouched — they predate this flow and would be
  re-flashed *by* it. The new host→device types only ever travel over USB, where the firmware
  is by definition new.

---

## Transport mode & "USB always wins"

The device persists a `transport` setting (NVS): `WIFI` or `NOTX`.

| Situation | Tally source | LED when no source |
|---|---|---|
| Any mode, USB session active | **USB** (USB wins) | n/a — app drives it |
| WIFI mode, unplugged | WiFi discovery → TCP | existing device-local states (cyan hunt, steady-blue lost-server) |
| NOTX mode, on USB, no app yet | none | device-local steady blue until the app connects |
| NOTX mode, unplugged | n/a | unpowered — No-TX devices live only on the cable |

No new **LED states**: a USB session presents to the LED state machine exactly like "server
connected"; the wired/USB indicator is **UI-side only** ([`docs/led.md`](../led.md) palette
unchanged). A plugged-in WiFi device **keeps its radio in STA and its association warm**
throughout the USB session (only the discovery/TCP tally client is gated off, so it never
double-connects to the sidecar) — tally comes from USB while connected, but the warm association
makes unplug-revert instant and keeps the streamed `wifiState`/`rssi`/`ssid` live and accurate.
A No-TX device keeps its radio off (ssidLen 0). The firmware never deinitialises the radio for a
USB session, which is what keeps `STATUS` SSID reads valid (an earlier `WiFi.mode(WIFI_OFF)` park
made `wm.getWiFiSSID(true)` return uninitialised-stack garbage after a replug).

---

## Flashing

Flashing a bare board uses Espressif's serial download protocol — wholly separate from the
protocol above. **Use `espflash` as a Rust crate** (`espflash = { version = "4", default-features
= false, features = ["serialport"] }`) in the Tauri shell; ship a prebuilt TallyBot firmware
`.bin` inside the app and flash the ESP32-C3 at runtime. `espflash` handles the native USB-JTAG
reset/download sequence; esptool-js was rejected (Web-Serial-only, unavailable in Tauri's
WebKitGTK webview).

**This is a proven, idiomatic pattern — not a research spike.** `espflash` is explicitly a
dual library + CLI crate, and multiple Tauri apps flash a bundled `.bin` through its library API.
Two to crib from directly (the docs are example-poor; read their source):

- **[EyeTrackVR/FirmwareFlashingTool](https://github.com/EyeTrackVR/FirmwareFlashingTool)** —
  reads the bundled `.bin`, wraps it in `RomSegment { addr: 0, data }`, calls
  `flasher.write_bins_to_flash(&segs, &mut progress)` with a `ProgressCallbacks` impl that
  streams progress to the frontend, then `flasher.connection().reset()`. This is the TallyBot
  pattern line-for-line.
- **[upsidedownlabs/NPG-Lite-Flasher](https://github.com/upsidedownlabs/NPG-Lite-Flasher)** —
  `Flasher::connect(...)` → `write_bin_to_flash(addr, data, …)`, reading bundled firmware from
  the Tauri resource dir with retry logic.

Caveat: the *library* API carries SemVer guarantees (the `cli` module does not), but it has
churned across majors — **pin an exact version** and follow the reference repos' usage for that
version.

**Native-USB lifecycle gotcha:** the CDC port *is* the running chip, so a flash/reset tears
down the USB endpoint — the OS sees an unplug/replug and the port path changes. The app must
expect the port to vanish and re-enumerate after flashing, and re-open by VID/PID, not a cached
path.

**Platform targets:** **Linux** (the dev machine) is the primary target; **Windows** is the
target for the official release. **macOS is out of scope** — no build/test/publish path is
planned. (The v1.2 milestone doc still lists macOS as a requirement; that needs reconciling —
see the note when this spec is wired into the milestone.)

---

## Host-side architecture

The orchestrator already depends on the `DeviceServerPort` interface (`app/sidecar/src/app.ts`),
not the concrete TCP `DeviceServer`. That's the seam a USB transport plugs into. A
`CompositeDeviceServer` fans `DeviceServerPort` out over `{ TCP, USB }` and **dedupes by MAC,
USB preferred** (same MAC on both ⇒ USB wins, TCP duplicate suppressed). The orchestrator stays
transport-agnostic.

**Board detection** (bare vs flashed — both enumerate as Espressif VID:PID `0x303A:0x1001`):
open the port **without asserting a reset** (a live No-TX device must keep rendering tally),
listen for a HELLO frame within ~1–2 s ⇒ TallyBot firmware; silence ⇒ unflashed ⇒ offer to flash.

### The Rust shell owns all serial (decided)

The Tauri shell (`src-tauri`) owns the serial port for its whole life — **flash + detect +
comms** — running **in the existing Tauri process on a dedicated thread**, not a separate
process. `serialport-rs` (blocking I/O) drives the PacketSerial/COBS read loop on that thread;
`espflash` runs its flash on a worker thread reporting progress via Tauri events. Both crates
compile straight into the shell binary — no native-addon packaging step.

**Why not the Node sidecar.** Flashing forces `espflash` (Rust) into the shell regardless, so
putting comms in Node would mean *two runtimes opening the same exclusive port across a
flash-induced re-enumeration* — a baton-pass race over the process boundary — **plus** the
`node-serialport` native-`.node` + `@yao-pkg/pkg` packaging trap. One Rust owner eliminates
both: a single owner across the messy port lifecycle, and no native module to pack.

**The bridge (the accepted cost).** The tally *brain* stays in the sidecar (it owns the ATEM +
engine), so USB-device colors flow sidecar → shell → device. This is **not** a new channel —
it extends the message vocabulary on the **existing shell↔sidecar NDJSON stdin/stdout bridge**:

- **Shell → sidecar** (over the channel the shell already writes for `send_to_sidecar`):
  `usbDeviceConnected {mac, version}`, `usbDeviceDisconnected {mac}`, `usbLog`, `usbStatus`.
- **Sidecar → shell** (the shell already reads the sidecar's stdout to forward to the UI; it
  now also demuxes serial-targeted messages): `usbSendColor {mac, …}`, `usbIdentify {mac}`,
  `usbProvisionWifi {port, ssid, pass}`, `usbSetTransport {port, mode}`, `usbFlash {port}`.

In the sidecar, the `CompositeDeviceServer`'s `UsbTransport` implements `DeviceServerPort` as a
thin proxy over this bridge: `sendColor`/`identify` write a command down it; inbound device
messages raise the `deviceConnected`/`deviceDisconnected` events the orchestrator already
consumes. The orchestrator stays transport-agnostic.

### IPC additions (`app/sidecar/src/ipc.ts`)

- **Device shape** gains `transport: "wifi" | "usb"` (drives the wired indicator) and exposes
  `wifiState`/`rssi` for the wizard.
- **New UI → sidecar commands:** `flashDevice {port}`, `provisionWifi {mac|port, ssid, pass}`,
  `setTransport {mac|port, mode}`, optionally `scanWifi {mac|port}`.
- **New sidecar → UI events:** `unflashedDeviceDetected {port}`, `flashProgress {port, pct,
  phase}`, a device-log/diagnostics stream sourced from `LOG` frames, and `scanResult`.

---

## Firmware must-do's

- **`Serial.setTxTimeoutMs(0)`** — mandatory. Without it, USB-CDC TX *blocks* when the host
  isn't reading and stalls the FastLED render loop ([arduino-esp32 #7779](https://github.com/espressif/arduino-esp32/issues/7779)).
- **Service USB RX every loop iteration** (drain all available bytes into the PacketSerial
  parser) so device→host TX never stalls; keep the render path non-blocking, never `delay()` on USB.
- **Emit HELLO on CDC-connect**, repeat ~1 s until a host frame arrives.
- **Never treat DTR as a reset/reprovision trigger** (so app connect doesn't interrupt a live
  No-TX device).

---

## Forward compatibility (v1.3 ESP-NOW)

The [ESP-NOW transport milestone](../milestones/v1.3-esp-now-transport.md) builds directly on
this protocol. The choices below are cheap to honour now and a costly retrofit later — **hold
them in v1.2; don't actually build ESP-NOW (YAGNI).**

- **Message bodies stay transport-agnostic.** The ESP-NOW packet payload will be the *identical*
  `[type][fields]` body, so the firmware parser and sidecar codec are reused verbatim and the
  bridge is a dumb byte-forwarder. No message body may assume its transport.
- **`transport` is an open enum everywhere** — the wire byte (`{0=No-TX, 1=WiFi}`, room for
  `2=ESP-NOW`), the firmware NVS field (store an int, not a bool), and the IPC `Device.transport`
  type (one centralized union, not `"wifi"|"usb"` copied across files). A `bridge` designation is
  a separate flag, not a transport value.
- **`CompositeDeviceServer` is an N-transport registry, not a TCP-vs-USB binary** — a list of
  transports with a data-driven priority order. v1.3 registers "ESP-NOW-via-bridge" as a third
  entry rather than rewriting the dedup logic.
- **One-device-per-USB-port is a v1.2 assumption, not a protocol guarantee.** USB `HELLO` /
  `SET_COLOR` target the single directly-connected device. A v1.3 *bridge* relays to many lights
  behind one USB endpoint, so reserve a **`RELAY`** host→device type byte now (intended shape
  `[type][targetMAC×6][inner message…]`), unimplemented, so v1.3 doesn't reshuffle the namespace.
- **Firmware decouples the message handler from the byte source** — a source yields parsed
  messages; tally/LED logic doesn't care if bytes came from TCP, USB-CDC, or (future) ESP-NOW.
- **The wizard's transport picker is a list, not hardcoded buttons** — ideally filtered by what
  the device's `STATUS`/version reports it supports, so v1.3 appends "ESP-NOW (no credentials)".
- **⚠️ Identity = the STA MAC.** ESP-NOW addresses peers *by MAC*. `HELLO` reports
  `WiFi.macAddress()` (the STA-interface MAC); **v1.3 must run ESP-NOW on the STA interface** so
  the ESP-NOW peer address equals the identity the sidecar already knows. Using a different
  interface (e.g. the SoftAP MAC, base+1) would split identity between what the sidecar maps and
  what the bridge must address. Easy to get right now, painful to discover later.

## Open questions

1. **Validate the flash path on real hardware** — the pattern is proven (see [Flashing](#flashing)),
   so this is ordinary integration work, not an unknown: pin an `espflash` version, follow the
   reference repos, bundle the `.bin`, and confirm an end-to-end flash + boot of TallyBot
   firmware on a real ESP32-C3 over **Linux** first, then **Windows**. It's still the
   load-bearing, hardware-dependent piece — build and test it *first*.
2. **Bridge message vocabulary** — finalize the `usb*` NDJSON message set on the existing
   shell↔sidecar pipe (see [Host architecture](#host-side-architecture)) when the
   `CompositeDeviceServer`/`UsbTransport` lands.

---

## Acceptance criteria (protocol-level; rolls up to the milestone)

- Every byte on the USB pipe is a COBS frame, including logs; a release device's stream
  decodes cleanly with no raw text, and the host resyncs past an injected garbage/panic-text run.
- `pio device monitor` on a dev-build (`TALLYBOT_USB_TEXT_LOG`) device still shows plain text.
- `SET_WIFI` persists creds (+ `transport=WiFi`) to the existing WiFi NVS and the device emits
  `STATUS(transport=WiFi, ssid=…, wifiState=joining)` at once (save-only — the confirm never gates
  on the join); the background association then streams `joining → connected/failed` as live,
  non-gating `wifiState`, and the creds apply when unplugged.
- `SET_TRANSPORT` persists the mode; USB wins while plugged; the device reverts correctly on
  unplug (WiFi → wireless tally; No-TX → unpowered).
- `SET_COLOR`/`IDENTIFY` over USB are byte-identical to TCP and render the same palette/animation.
- The same MAC plugged in over USB while also on WiFi appears **once** on the board (USB), with
  a wired indicator.
- A bare ESP32-C3 is detected (no HELLO within timeout) and flashed in-app via `espflash`; the
  port re-enumerates and the device reconnects as wired.
- Holding BOOT on a deployed WiFi device still opens the WiFiManager portal (unchanged).
```

# TallyBot — Roadmap

Future work beyond v1, with the design decisions behind each item. Acceptance criteria
are defined when an item is scheduled into a milestone.

The product thesis these items serve — the "buy hardware, install app, done" differentiator
— lives in [`docs/goals.md`](../goals.md) ("Positioning").

---

## Onboarding & transport (near-term focus)

These have settled design decisions and are scheduled into milestones: item 1 forms
[v1.2 — Zero-Friction Onboarding](v1.2-zero-friction-onboarding.md); item 2 follows in
[v1.3 — ESP-NOW Transport](v1.3-esp-now-transport.md). In-app flashing (item 3 in the
original plan) is **deferred** — see [Deferred](#deferred--open-questions) below.

### 1. USB serial provisioning — [v1.2](v1.2-zero-friction-onboarding.md)

While a device is plugged in via USB-C, all communication happens over USB — there is
no reason to use wireless with a stable wired connection. The app provisions the device's
**unplugged behaviour**: WiFi mode (SSID + password; device confirms the join over USB
before the user unplugs) or No-TX mode (WiFi disabled; device only operates when cabled,
makes no wireless attempt when unplugged — for permanent wired installations).

The protocol is COBS-framed binary over USB-CDC, specified in
[`docs/spec/usb-serial-protocol.md`](../spec/usb-serial-protocol.md). Key messages:
`SET_WIFI`, `SET_TRANSPORT`, `GET_STATUS` / `STATUS`, `SET_COLOR` (byte-identical
to TCP). Logs become `LOG` frames; no raw text on the wire in release builds.

The Rust shell owns the serial port (flash + detect + comms on a dedicated thread via
`serialport-rs`); the tally engine stays in the sidecar and talks to USB devices through the
existing shell↔sidecar NDJSON bridge via `UsbTransport` / `CompositeDeviceServer`.

**Fallback:** the WiFiManager SoftAP captive portal is retained for field re-provisioning —
hold **BOOT** on power-up when no laptop is available.

### 2. ESP-NOW transport — [v1.3](v1.3-esp-now-transport.md)

After the second venue test, WiFi-join reliability proved to be dominated by venue
access-point *policy* the device can't change (a weak-signal / min-RSSI kick); this
transport sidesteps it entirely. A bridge
dongle (the *same* ESP32-C3 SuperMini hardware running bridge firmware) plugs into the
streaming PC via USB and talks to tally lights over **ESP-NOW** — Espressif's peer-to-peer
MAC-layer protocol that needs no AP, router, or network infrastructure.

- **Transport selection is exclusive.** Each device is provisioned in *either* WiFi or
  ESP-NOW mode at provisioning time; the two never run simultaneously on one device.
  Simultaneous dual-transport was evaluated and **rejected** — possible, but it adds
  firmware/app/channel-coordination complexity to solve a narrow failure already covered by
  robust reconnection.
- **Bridge dongle:** same hardware, same firmware — any USB-connected device can be
  designated as a bridge in the UI, at which point it relays commands to nearby ESP-NOW
  lights instead of acting as a tally light.
- **Discovery** mirrors the UDP broadcast logic one layer down: lights broadcast
  `TALLY_FIND` to the ESP-NOW broadcast MAC; the bridge registers the light as a peer and
  unicasts `TALLY_HERE` back; the light registers the bridge, sends HELLO, receives
  SET_COLOR.
- **Topology: star.** The bridge is the sole hub; lights don't relay through each other.
  Multi-hop mesh was **rejected** — for target venues (single room, 2–5 cameras within 50m
  of the PC), ESP-NOW's ~220m line-of-sight range makes relay unnecessary.
- **Channel:** lights join no AP, so all devices sit on a fixed agreed channel (e.g. 1) —
  no negotiation.
- **Message format:** the existing length-prefixed binary protocol
  ([`docs/architecture.md`](../architecture.md)) is reused unchanged. Transport is a
  delivery detail; the message schema is identical whether a packet arrived over TCP or
  ESP-NOW.

### 4. Multi-ME support

The app currently hardcodes `mixEffects[0]` (ME 1), correct for the ATEM Mini. Larger ATEMs
(Extreme, 2 M/E, 4 M/E) have multiple Mix Effects, each with its own Program/Preview bus —
an input can be live on ME 1 and on preview on ME 2 at once.

- App setting: which ME(s) each device follows (default: ME 1 only).
- Priority when a camera is on multiple MEs: **Live > Preview > Idle**.
- ATEM Mini users are unaffected (single ME, no new config).

**Why it matters:** without it, every user with a larger ATEM gets incorrect tally state. A
straightforward generalisation that significantly expands the viable install base.

> Distinct from **Multi-switcher** (below), which is about more than one *physical* ATEM.
> Multi-ME is multiple busses on *one* switcher.

---

## Further out

- **OTA firmware updates** — flash new firmware over WiFi from the app, no cable. Builds on
  the in-app flashing infrastructure (item 1).
- **Web UI** — a browser-accessible view served by the sidecar, readable from other devices
  on the network (phones, tablets at the mixing desk).
- **In-app device diagnostics** — per-device health panel (RSSI, IP, uptime, reconnect
  count, firmware version), fed by a new device→server diagnostic frame. (Partly underway
  as part of production hardening.)
- **Per-device colour customisation** — custom colours per device or input, beyond the
  fixed red/green/white palette. (Per-device *brightness* is already v1.)
- **Multi-switcher** — connect more than one *physical* ATEM simultaneously; each device is
  still assigned to one input on one switcher.
- **OBS integration (obs-websocket)** — two paths, one cheap, one a refactor:
  - **Override / program-gate** (cheap — already modelled in the IPC schema): monitor OBS's
    active scene; when it does *not* contain the ATEM feed, the program-gate forces every
    device to Idle. ATEM always drives per-camera tally; OBS only contributes the global
    "all idle" override. Wiring the OBS side is purely additive.
    See [`docs/goals.md`](../goals.md).
  - **OBS as an input source** (deferred refactor): treat OBS as the switcher — cameras are
    OBS scenes, per-scene tally drives the lights. Reshapes the IPC schema (`source` becomes
    polymorphic). The override path does *not* require this.
- **Non-ATEM switchers** — a general multi-source model (Tricaster, vMix, Roland). Requires
  the same source-polymorphism refactor as OBS-as-an-input-source.

---

## Deferred / open questions

Identified, not rejected, lower priority with open design questions.

- **In-app firmware flashing** — the app detects a bare ESP32-C3 and flashes TallyBot firmware
  without the user touching PlatformIO or the Arduino IDE. Designed and unblocked (`espflash`
  Rust crate in the Tauri shell, bundled `.bin`; see [Flashing](../spec/usb-serial-protocol.md#flashing)
  in the USB spec), but deprioritised: USB provisioning + ESP-NOW transport were higher-value.
  The most popular competitor offers only a separate browser-based web flasher; doing it inside
  the desktop app as a single unified flow remains the key differentiator. **Enables OTA** (same
  write infrastructure aimed at a connected device over WiFi). Schedule after v1.3 is stable.

- **WiFi-join reliability (one day)** — make the WiFi transport dependable on arbitrary venue
  networks, deferred from [`v1.1-production-hardening.md`](v1.1-production-hardening.md) when the
  project pivoted to ESP-NOW. The firmware hardening (TX-power policy, manual channel range,
  on-device diagnostics with the joined-vs-kicked verdict) already shipped; what remains is the
  part the device *can't* fix alone — managed-AP policy (min-RSSI kick, band-steering) seen at
  the second venue — plus a WiFiManager special-char URL-decode audit. ESP-NOW sidesteps all of
  it for now; revisit if/when WiFi is wanted as a first-class transport again. Living runbook
  (symptoms, diagnostics, what to try next): [`../wifi-troubleshooting.md`](../wifi-troubleshooting.md).
- **PC hotspot mode** — the app creates a Windows Mobile Hotspot so lights connect directly
  to the PC with no venue router. Solves the same "no venue WiFi" problem as the ESP-NOW
  bridge but needs no extra hardware. Lower priority now that the ESP-NOW bridge is
  confirmed; revisit if carrying a bridge dongle proves too much friction.
- **Battery + enclosure story** — power and physical packaging are the most-cited unmet
  needs across DIY tally projects. A reference 3D-printed enclosure (MakerWorld/Thingiverse)
  plus a documented USB power-bank recommendation would close a gap no open-source project
  currently owns. Post-v1.

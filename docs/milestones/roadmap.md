# TallyBot — Roadmap

Future work beyond v1, with the design decisions behind each item. Acceptance criteria
are defined when an item is scheduled into a milestone.

The product thesis these items serve — the "buy hardware, install app, done" differentiator
— lives in [`docs/goals.md`](../goals.md) ("Positioning").

---

## Onboarding & transport (near-term focus)

The next things to build. These have settled design decisions; they're here rather than in
a milestone doc until they're scheduled with acceptance criteria.

### 1. In-app firmware flashing

The app detects an ESP32-C3 plugged in via USB-C, offers to flash the TallyBot firmware,
and handles the whole process without the user touching any external tools.

- The Node.js sidecar watches for serial-port appearance on device connect.
- [`esptool-js`](https://github.com/espressif/esptool-js) (the JS port of Espressif's flash
  tool) is bundled in the sidecar and writes the firmware binary. The C3's native USB means
  no FTDI adapter and no driver install.
- Firmware ships as a versioned `.bin` GitHub release artifact; the app downloads and caches
  the latest.

**Why:** removes PlatformIO and the Arduino IDE from the user's path entirely. The most
popular competitor (AronHetLam) offers a *separate* browser-based web flasher; doing it
inside the desktop app as one unified flow is the step nobody has taken.

**Enables OTA** (see below): once delivery + write infrastructure exists, over-the-air is
the same machinery aimed at a connected device instead of a USB one.

### 2. USB serial provisioning

Immediately after flashing, while the device is still plugged in, the app sends WiFi
credentials over the serial connection. The user never switches their laptop's WiFi network.

Protocol (app ↔ device over serial):
```
App    → Device:  TALLY_PROVISION:MyNetwork:password\n
Device → App:     TALLY_OK\n
```

- On boot the firmware opens a brief (~5s) serial listening window before WiFi init. A
  `TALLY_PROVISION` command stores creds to NVS and acks; the app sends right after flash
  completes, so the window is always hit in the provisioning flow.
- No command (normal boot) → the window expires and the device proceeds normally.

**Fallback:** the WiFiManager SoftAP captive portal is retained for field re-provisioning —
hold **BOOT** on power-up to trigger the SoftAP when no laptop is available. WiFiManager
stays in the firmware but leaves the primary user-facing story.

**Full onboarding flow this enables:** plug in via USB-C → app detects "new device" → user
enters SSID + password → app flashes, then sends creds over serial → device reboots, joins
WiFi, appears via UDP discovery → user types "Camera 1" → unplug, mount, power from a bank.

### 3. ESP-NOW transport — active focus (June 2026)

The near-term build. After the second venue test, WiFi-join reliability proved to be
dominated by venue access-point *policy* the device can't change (a weak-signal / min-RSSI
kick), so this is the path being pursued now for dependable venue connectivity. A bridge
dongle (the *same* ESP32-C3 SuperMini hardware running bridge firmware) plugs into the
streaming PC via USB and talks to tally lights over **ESP-NOW** — Espressif's peer-to-peer
MAC-layer protocol that needs no AP, router, or network infrastructure.

- **Transport selection is exclusive.** Each device is provisioned in *either* WiFi or
  ESP-NOW mode at provisioning time; the two never run simultaneously on one device.
  Simultaneous dual-transport was evaluated and **rejected** — possible, but it adds
  firmware/app/channel-coordination complexity to solve a narrow failure already covered by
  robust reconnection.
- **Bridge dongle:** same hardware (no new parts), dedicated firmware, plugged into the PC
  permanently during operation; relays ESP-NOW ↔ USB serial to the sidecar over the same
  serial infrastructure used for flashing/provisioning.
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

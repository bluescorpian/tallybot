# Spec: ESP-NOW transport (bridge + lights)

Pre-implementation design for milestone
[`v1.3 — ESP-NOW Transport`](../milestones/v1.3-esp-now-transport.md). The transport-level
decisions (why ESP-NOW, star topology, fixed channel, exclusive transport per device, reuse
of the binary message format) were made in
[`roadmap.md`](../milestones/roadmap.md#3-esp-now-transport); the forward-compat seams were
reserved in the [v1.2 USB-serial spec](usb-serial-protocol.md#forward-compatibility-v13-esp-now).
This spec designs the two extensions the milestone flags as unspecced — the ESP-NOW transport
mode + bridge designation, and relay addressing — plus the firmware link layer and the
host-side plumbing.

Scope: everything between the sidecar and an ESP-NOW light's LED. **Out of scope:** mesh
relaying (rejected — star only), multiple simultaneous bridges, encrypted ESP-NOW (see
[Security](#security-accepted-tradeoffs)), PC-hotspot transport (separate roadmap item).

---

## Decisions at a glance

| Concern | Decision | Why / piggyback on |
|---|---|---|
| **Transport wire value** | `ESPNOW = 2` in the existing open `transport` enum | Reserved by v1.2 (`{0=No-TX, 1=WiFi}`, "room for 2") |
| **Bridge designation** | New host→device `SET_BRIDGE 0x08 [type][enabled][channel]`, **runtime-only** (never persisted on the device) | Bridge is a flag, not a transport value (v1.2 spec); the *sidecar* persists which MAC is the bridge and re-asserts it — firmware stays lean |
| **Relay down (host→light)** | `RELAY 0x07 [type][targetMAC×6][inner…]` over USB to the bridge; bridge unwraps and `esp_now_send(targetMAC, inner)` | Shape reserved verbatim by v1.2 |
| **Relay up (light→host)** | Device→host `RELAY 0x06 [type][srcMAC×6][inner…]`; bridge wraps every peer frame it receives | Symmetric envelope (the two directions' type spaces are independent, so both ends of the pipe call it RELAY); the source MAC comes from the ESP-NOW receive callback, so MAC-less payloads (HEARTBEAT) stay attributable |
| **ESP-NOW payload** | The raw `[type][fields…]` body, one message per ESP-NOW datagram — **no framing, no length prefix, no COBS** | ESP-NOW is datagram-based (≤250 B; our largest message is 12 B); the v1.2 "payloads are transport-agnostic" rule holds |
| **Checksum** | **None** at the app layer | Resolves the question v1.2 left open: ESP-NOW rides 802.11 action frames with FCS — corrupt frames are dropped at the MAC layer, and the ~1 s keyframe heals the loss |
| **Reliability** | None — fire-and-forget, no ack/retry | Decided in the milestone: the keyframe tick (`REFRESH_PERIOD_MS`) already re-asserts every colour ~1 s on all transports |
| **Channel** | **Channel 1 by default, host-chosen on the wire** — `SET_TRANSPORT(2)` and `SET_BRIDGE` carry a channel byte; lights persist it, STATUS reports it | Decided in roadmap (lights join no AP, so nothing negotiates a channel); carrying it on the wire means a crowded venue can be escaped with a host update, no firmware re-flash. The sidecar sends `ESPNOW_CHANNEL = 1` everywhere today — configurability is wire-level, not UI-level |
| **Interface / identity** | ESP-NOW runs on the **STA interface** on both ends | v1.2's hard constraint: peer address == the STA MAC the sidecar already keys devices by |
| **Discovery** | Light broadcasts `TALLY_FIND` to `ff:ff:ff:ff:ff:ff`; bridge registers the sender as a peer and unicasts `TALLY_HERE` back | Decided in roadmap; mirrors UDP discovery one layer down |
| **Host plumbing** | Zero Rust-shell changes; RELAY-down rides the existing `usbSend`, RELAY-up rides the existing opaque `usbFrame` | The shell parses only 8-byte HELLOs and forwards everything else opaquely — relay frames pass through untouched by construction |
| **Sidecar seam** | `EspNowTransport implements DeviceServerPort`, registered as the third `CompositeDeviceServer` member | The N-transport registry was built for exactly this |
| **Versioning** | `PROTOCOL_VERSION.CURRENT` 2 → **3**; `MIN_SUPPORTED` stays 1 | The app only sends `SET_BRIDGE`/`RELAY` (and offers ESP-NOW provisioning) to devices reporting ≥ 3 |

**Rejected:** per-message acks/retries (keyframe covers loss; ESP-NOW unicast does give a
MAC-level send status, but acting on it would add state for a problem the keyframe already
solves). A persisted bridge flag in firmware NVS (the sidecar already has to track the
designated bridge to route colours, so device-side persistence would only create a second
source of truth that can disagree). A compiled-in fixed channel (kept as the default, but a
crowded venue would then require a re-flash of every light to escape — one wire byte buys
the way out).

---

## Wire protocol changes

All three protocol mirrors change (`protocol.ts` — source of truth, `protocol.h`,
`protocol.rs`). The Rust mirror needs **no functional change** (it still parses only HELLO);
only its comments should note the new types it forwards opaquely.

### Transport enum

```
Transport: { NOTX: 0, WIFI: 1, ESPNOW: 2 }
```

`SET_TRANSPORT 0x04` accepts `2` with an optional trailing channel byte:
`[type][mode]` for No-TX/WiFi (unchanged), `[type][mode][channel]` for ESP-NOW. The device
persists both to NVS (channel defaults to 1 when the byte is absent or the device was
provisioned by an older host). Provisioning a light for ESP-NOW is otherwise exactly the
v1.2 No-TX flow: persist, applies next boot, no SSID/password, `STATUS` confirms. The
STATUS `transport` byte already carries the open enum.

### New message types

**Host → device** (USB only; the bridge is by definition USB-connected):

| Message | Type | Payload | Notes |
|---|---|---|---|
| RELAY | `0x07` | `[type][targetMAC×6][inner…]` | Was reserved; now implemented. The bridge strips the 7-byte header and sends `inner` verbatim to `targetMAC` over ESP-NOW. Target not a registered peer ⇒ drop silently (the light's re-discovery + keyframe recover). Never persisted, never interpreted by the bridge beyond the header. |
| SET_BRIDGE | `0x08` | `[type][enabled][channel]` | `enabled=1` = enter bridge mode now on `channel`, `0` = leave it (channel ignored). **Runtime-only** — survives neither reboot nor unplug. Device replies with `STATUS` (whose trailing bytes confirm the mode + channel, below). Sent only to devices with version ≥ 3. |

**Device → host** (USB only):

| Message | Type | Payload | Notes |
|---|---|---|---|
| RELAY | `0x06` | `[type][srcMAC×6][inner…]` | The bridge wraps every ESP-NOW frame received from a registered peer and forwards it up. `srcMAC` is taken from the ESP-NOW receive callback (the peer's STA MAC), not from the inner payload — so HEARTBEAT (which carries no MAC) stays attributable. The Rust shell forwards it opaquely as a `usbFrame`; the sidecar decodes the envelope and dispatches `inner` through the existing `decodeDeviceMessage`. (Direction-scoped type spaces: `0x06` device→host and `0x07` host→device are both "RELAY".) |

### STATUS gains two trailing bytes

```
STATUS 0x03  [type][transport][wifiState][rssi][ssidLen][ssid…][channel][bridging]
```

`channel` = the device's stored ESP-NOW channel (default 1); `bridging` = 1 while bridge
mode is active. Both are **additive and optional**: the v1.2 decoder validates only minimum
lengths and ignores trailing bytes (the protocol's documented skip-trailing-fields rule), so
v2 hosts tolerate v3 devices, and the v3 host treats missing trailing bytes as
channel-unknown/not-bridging. The host uses them to confirm `SET_BRIDGE` took effect and to
surface bridge state in the UI.

### Versioning

`CURRENT` 2 → **3**, `MIN_SUPPORTED` stays 1. A v3 HELLO means the firmware understands
`SET_TRANSPORT(2)`, `SET_BRIDGE`, `RELAY`, and emits the STATUS trailing
`[channel][bridging]` bytes. The app:

- offers the ESP-NOW transport row only for devices reporting ≥ 3 (the wizard's picker is
  already filtered-by-capability by design);
- offers bridge designation only for USB-connected devices reporting ≥ 3;
- never sends the new types to older devices. Existing v1/v2 devices are untouched.

ESP-NOW lights report version 3 in the HELLOs they send through the bridge.

---

## ESP-NOW link layer (firmware ↔ firmware)

### Radio configuration (both roles)

- `WiFi.mode(WIFI_STA)`, **no association**, `esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE)`
  — the light's persisted channel / the bridge's `SET_BRIDGE` channel (`ESPNOW_CHANNEL = 1`
  is the default everywhere) — then `esp_now_init()`. ESP-NOW runs on the STA interface so
  the peer address equals the HELLO MAC (`WiFi.macAddress()` — already the device identity).
- TX power full (`WIFI_POWER_19_5dBm`), matching the existing WiFi path.
- The existing `esp_wifi_set_country()` setup is kept; channel 1 is legal everywhere.
- A **bridge that is WiFi-provisioned** must drop/suppress its STA association while bridging
  (an association would drag the radio to the AP's channel). On `SET_BRIDGE 0` or USB session
  end, it restores normal behaviour per its NVS transport mode.

### Discovery and link

Mirrors the UDP flow one layer down (decided in roadmap):

1. Light broadcasts the bytes `TALLY_FIND` to `ff:ff:ff:ff:ff:ff` every 2 s
   (`DISCOVERY_INTERVAL_MS`, reused).
2. Bridge receives it, registers the sender's MAC as an ESP-NOW peer, and unicasts the
   same `TALLY_HERE:7000` string back the UDP server uses (one reply format on both
   transports; lights prefix-match and ignore the port, which is meaningless over ESP-NOW).
3. Light registers the bridge's MAC as its (single) peer, sends `HELLO`, and repeats it
   every 1 s until the first frame arrives from the bridge (the same retry pattern HELLO
   already uses on USB connect).
4. From then on the light sends `HEARTBEAT` every 10 s (`HEARTBEAT_INTERVAL_MS`, reused) and
   renders whatever `SET_COLOR`s arrive.

The discovery strings can't be confused with binary messages: their first byte is ASCII `T`
(`0x54`), outside the type-byte range. The bridge handles `TALLY_FIND` locally; **every other
peer frame is wrapped in the RELAY-up envelope and forwarded up unread** (dumb byte-forwarder).

### Liveness

- **Light → "is the bridge alive?"**: every connected light receives ≥ 1 frame/s (the
  keyframe). No ESP-NOW traffic for **5 s** (`ESPNOW_LINK_TIMEOUT_MS = 5000`) ⇒ the link is
  dead: drop the peer, resume discovery broadcasts.
- **Sidecar → "is the light alive?"**: the relayed HEARTBEAT resets the same 30 s per-device
  timer the TCP server uses. Expiry ⇒ `deviceDisconnected`. When the **bridge** itself
  disconnects (USB unplug), all its relayed lights drop immediately.
- The bridge tracks nothing about liveness — it only maintains its peer table.

### Bridge peer table

Auto-registration on `TALLY_FIND` receipt. ESP-NOW caps unencrypted peers at 20 (target
venues use 2–5 lights). When full, a new `TALLY_FIND` is dropped with a `LOG` warn frame —
no eviction in v1.3.

### Security (accepted tradeoffs)

Unencrypted, unauthenticated. The payload is tally colours; the threat model (someone within
ESP-NOW range injecting `SET_COLOR`s mid-production) is accepted for v1.3, like the existing
unauthenticated TCP path. ESP-NOW's LMK/PMK encryption would add a pairing/key-distribution
flow for negligible benefit; revisit only if the protocol ever carries anything sensitive.

---

## Firmware behaviour

### New transport mode: ESP-NOW light (`transport = 2` in NVS)

Boot path (third branch alongside WiFi and No-TX in `setup()`): radio up as above, start
discovery, `ind::searching()` (cyan pulse — same meaning as "searching for server").
Then per the existing LED taxonomy, **no new LED states**:

| Phase | LED | Driven by |
|---|---|---|
| Searching for a bridge (never linked) | Cyan pulse — existing state 4 | device |
| Linked, awaiting first server frame | White breathe — existing state 5 hand-off rule | device |
| Linked, operating | Whatever `SET_COLOR` says (states 5–11) | server |
| Lost the bridge (was linked) | Steady blue — existing state 10 "lost the server" | device |

The amber states never apply (amber = WiFi/AP trouble; an ESP-NOW light has no AP — its
upstream is the bridge, and bridge-loss is exactly "lost the server"). Received `SET_COLOR`s
dispatch through the existing `control::dispatch` — the v1.2 "message handler is decoupled
from the byte source" rule means ESP-NOW is just a third byte source.

**USB wins, as always:** while a USB host session is active, an ESP-NOW-provisioned light
gates its ESP-NOW client off (no discovery broadcasts), exactly as the WiFi tally client is
gated off — tally comes from USB. It resumes on session end. `STATUS` for an ESP-NOW light
reports `transport=2, wifiState=idle, ssidLen=0`.

### Bridge mode (runtime, any transport's NVS setting underneath)

Entered on `SET_BRIDGE 1` over USB (exited on `SET_BRIDGE 0` or USB session end — host
gone/port closed — whichever comes first). While active:

- Radio per [link layer](#radio-configuration-both-roles); WiFi association suppressed.
- `TALLY_FIND` → register peer + unicast `TALLY_HERE`.
- Any other peer frame → wrap in RELAY-up `[0x06][srcMAC]` → send up the USB pipe.
- `RELAY` from USB → strip header → `esp_now_send(targetMAC, inner)`.
- Everything else about the device is **unchanged**: it still answers `GET_STATUS`, still
  renders direct (unwrapped) `SET_COLOR`s, and can still be assigned as a tally light — a
  bridge is a normal USB tally device that *additionally* relays. No special LED state; the
  wired/bridge indication is UI-side, per the v1.2 precedent.

Teardown restores the radio to the device's own NVS transport mode (WiFi mode resumes its
warm-association behaviour; No-TX returns the radio to off; an ESP-NOW light resumes
discovery). Implementation may rebuild radio state directly rather than reboot — the device
must keep rendering through designation changes.

---

## Sidecar

### `EspNowTransport` (new, `app/sidecar/src/espnow-transport.ts`)

Implements `DeviceServerPort`, registered as the third composite member:

```ts
new CompositeDeviceServer([
  { transport: "usb",    port: usb },     // priority 0 — unchanged
  { transport: "wifi",   port: tcp },     // priority 1 — unchanged
  { transport: "espnow", port: espnow },  // priority 2 — new
], usb)
```

Priority is mostly moot (a device is provisioned for exactly one wireless transport), but
USB-above-ESP-NOW matters: a light cabled for re-provisioning dedupes to its USB presence.

- **Outbound:** `sendColor(mac, …)` → `relayPayload(mac, setColorPayload(…))` → `usbSend`
  targeted at the **designated bridge's MAC**. Returns false when no bridge is online.
- **Inbound:** `UsbTransport` decodes nothing new — it gains one hook: a RELAY-up frame
  (decoded by the shared codec) is re-emitted as a `relayed {bridgeMac, srcMac, inner}`
  event instead of being dropped as unknown. `EspNowTransport` subscribes, runs `inner`
  through `decodeDeviceMessage`, and maintains its own `mac → {version, lastSeen}` map with
  the 30 s expiry, emitting `deviceConnected` / `deviceDisconnected` / `deviceUnsupported`
  exactly like the TCP server.
- `protocol.ts` additions: `Transport.ESPNOW`, `DeviceMessageType.RELAY: 0x06` /
  `ServerMessageType.SET_BRIDGE: 0x08` constants, `ESPNOW_CHANNEL = 1`,
  `relayPayload(mac, inner)`, `setBridgePayload(enabled, channel)`, the `setTransportPayload`
  channel byte, a `parseMac` helper (string → 6 bytes, the inverse of `formatMac`),
  `decodeDeviceMessage` handling for the relay envelope and the STATUS
  `[channel][bridging]` trailing bytes, and the version bump.

### Bridge designation

- `ConfigStore` gains `bridgeMac: string | null` (persisted — designation survives restarts).
- New UI command `setBridge { mac: string | null }` (null = un-designate; designating a new
  MAC replaces the old — **one bridge per session**, multiple bridges out of scope).
- `SidecarApp` sends `SET_BRIDGE 1` to the designated device whenever it is USB-connected
  with version ≥ 3 (on designation, and again on every USB reconnect — runtime flag,
  re-asserted by the host), `SET_BRIDGE 0` to a device being un-designated. The STATUS
  `bridging` byte confirms; the device's IPC entry reports it.

### IPC (`ipc.ts`)

- `SetTransportCommand.mode` widens to `"notx" | "wifi" | "espnow"` (the change v1.2's
  comment reserved); `transportModeValue`/`provisionedModeName` in `usb-transport.ts` map
  `"espnow" ↔ 2`.
- New `SetBridgeCommand { type: "setBridge", mac: string | null }` (+ registry entry).
- `Device` gains `bridge?: boolean` (true while the device is the designated, confirmed
  bridge). `DeviceTransport` already contains `"espnow"`; relayed lights surface with
  `transport: "espnow"`.

No engine changes: relayed lights are online devices like any other, and the keyframe tick
already covers ESP-NOW loss (the whole point of the v1.2 decision).

---

## UI

- **Transport picker** (`DeviceConfig.svelte`): un-disable the existing ESP-NOW row (drop the
  "Soon" pill) for devices with `protocolVersion ≥ 3`; picking it commits inline like No-TX
  (`page: false` — no credential step). Stays disabled (with the pill) for older firmware.
- **Bridge designation**: a new USB-gated section in the same Configure pane (the established
  home for wired-only device settings) — a "Use as bridge" toggle, version-gated ≥ 3. Wired
  to the new `setBridge` command; reflects `device.bridge`. Designating shows inline that any
  previously designated device is replaced.
- **Board**: ESP-NOW lights appear as ordinary lights (`transport: "espnow"`, no wired cuff).
  The bridge device keeps its USB cuff and gains a small bridge marker (flat-language badge,
  consistent with the wired chip). Mock state gains an ESP-NOW light and a designated bridge
  so the flow is browser-drivable.

---

## Mixed sessions

Nothing coordinates because nothing conflicts: WiFi lights ride TCP, ESP-NOW lights ride
RELAY-over-USB-over-the-bridge, USB devices ride their cable. The composite dedupes by MAC
across all three. The engine and keyframe treat every online device identically. The
acceptance criterion (mixed session works) falls out of the architecture rather than needing
code.

---

## Acceptance criteria (protocol-level; rolls up to the milestone)

- A v3 device designated as bridge in the UI confirms via the STATUS `bridging` byte, answers discovery,
  and relays: lights with `transport=2` in NVS show correct live/preview/idle with **no WiFi
  network present**, through one bridge, several lights at once.
- Killing a light mid-session drops it from the board within ~30 s; unplugging the bridge
  drops all its lights immediately; replugging the bridge re-designates automatically
  (persisted `bridgeMac`) and lights relink without operator action.
- A dropped ESP-NOW frame is invisible to the operator (next keyframe corrects within ~1 s).
- The wizard's ESP-NOW path never asks for credentials; `SET_TRANSPORT(2)` + unplug is the
  whole provisioning flow.
- v1/v2 devices: WiFi-only deployments behave byte-identically to v1.2 (no new frames are
  ever sent to them).
- A light provisioned ESP-NOW and then cabled over USB appears once (USB wins), can be
  re-provisioned to WiFi, and the reverse round-trip works.

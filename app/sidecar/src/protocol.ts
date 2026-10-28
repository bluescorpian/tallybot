/**
 * Binary device↔server wire protocol — the server (sidecar) side.
 *
 * Source of truth: `docs/architecture.md` ("Binary Message Protocol"). These values
 * are mirrored in TWO other places — keep all three in sync:
 *   • `firmware/src/protocol.h`        (C++, the device)
 *   • `app/src-tauri/src/usb/protocol.rs` (Rust, the USB-serial shell — a *minimal*
 *     mirror: COBS framing + HELLO parse only; every other payload is forwarded
 *     opaque so this file stays the single payload codec authority).
 *
 * Framing is **transport-specific; payloads are shared**. The `[type][fields…]`
 * payloads below ride unchanged over both transports; only the wrapper differs:
 *   • TCP — length-prefixed: a single leading byte gives the number of payload
 *     bytes that follow. One uniform loop frames any message regardless of length,
 *     which lets a parser skip a message (or trailing fields) it doesn't recognise.
 *       [len][payload …]      len = count of payload bytes that follow (1 byte, 0–255)
 *   • USB — COBS (Consistent Overhead Byte Stuffing), self-synchronising on a lone
 *     `0x00` delimiter. Framed by PacketSerial (firmware) / a cobs crate (shell);
 *     this file only builds/parses the payloads, never the COBS wrapper.
 */

// ── Network ports ───────────────────────────────────────────────────────────

/** TCP server devices connect to (the stable endpoint). */
export const SERVER_PORT = 7000;
/** UDP port used for broadcast discovery in both directions. */
export const DISCOVERY_PORT = 7001;

// ── Message types (the first payload byte) ──────────────────────────────────
// Device→server and server→device type spaces are independent; both start at 0x01.
// HELLO/HEARTBEAT/SET_COLOR travel over both transports; the rest are USB-only
// provisioning/diagnostics frames (a USB device is by definition new enough to
// speak them — see the versioning note below), except that an ESP-NOW light also
// sends LOG to its bridge, which relays it up inside a RELAY envelope.

/** Device → server (a.k.a. device → host) message types. */
export const DeviceMessageType = {
  HELLO: 0x01,
  HEARTBEAT: 0x02,
  /** Transport/WiFi status snapshot, pushed on change and in reply to GET_STATUS (USB). */
  STATUS: 0x03,
  /**
   * A framed log line — replaces raw Serial.print on release firmware (USB). An ESP-NOW light
   * also sends one to its bridge (e.g. its relink gap report), arriving inside a RELAY.
   */
  LOG: 0x04,
  /**
   * `[type][index][total][channel][rssi][ssidLen][ssid…]` — one access point a cabled device
   * heard, in reply to SCAN_WIFI (USB, v4). See {@link ScanResultMessage}.
   */
  SCAN_RESULT: 0x05,
  /**
   * `[type][srcMAC×6][inner…]` — an ESP-NOW frame a bridge received from a light,
   * forwarded up the USB pipe. `srcMAC` comes from the ESP-NOW receive callback, so
   * MAC-less inner payloads (HEARTBEAT) stay attributable (USB, bridge only). The
   * device→host and host→device type spaces are independent, so this shares the name
   * "RELAY" with the host→device `ServerMessageType.RELAY` (0x07) — same envelope, both
   * directions, distinct values.
   */
  RELAY: 0x06,
  /**
   * `[type][utf8 version…]` — the firmware's own semver (firmware/VERSION), sent right after
   * every HELLO on every transport. A separate type rather than a longer HELLO because hosts
   * that predate it skip an unknown type but reject a HELLO that isn't exactly 8 bytes.
   * Firmware that predates it never sends one.
   */
  FIRMWARE: 0x07,
} as const;

/** Server → device (a.k.a. host → device) message types. */
export const ServerMessageType = {
  SET_COLOR: 0x01,
  // 0x02 retired (was IDENTIFY): flashing is now driven server-side over SET_COLOR.
  /** Persist WiFi creds and start a background join; never gates on it (USB). */
  SET_WIFI: 0x03,
  /** Persist the transport mode (No-TX / WiFi) (USB). */
  SET_TRANSPORT: 0x04,
  /** Request a STATUS frame (USB). */
  GET_STATUS: 0x05,
  /** `[type]` — scan channels 1–13 for access points; the device replies with SCAN_RESULTs (USB, v4). */
  SCAN_WIFI: 0x06,
  /**
   * `[type][targetMAC×6][inner…]` — sent over USB to a bridge, which strips the 7-byte
   * header and sends `inner` verbatim to `targetMAC` over ESP-NOW (USB, bridge only).
   */
  RELAY: 0x07,
  /**
   * `[type][enabled][channel]`, or `[type][enabled][channel][txPower]` to a v4 device — enter/leave
   * bridge mode. Runtime-only; never persisted (USB).
   */
  SET_BRIDGE: 0x08,
} as const;

// ── Shared field enums (used inside the payloads above) ──────────────────────

/**
 * How a device reaches the server when unplugged. **Open enum** — store as an int
 * everywhere (NVS, wire byte, IPC), never a bool.
 */
export const Transport = {
  NOTX: 0,
  WIFI: 1,
  /** Receives tally over ESP-NOW from a USB-connected bridge; joins no network. */
  ESPNOW: 2,
} as const;

/**
 * The default ESP-NOW channel: the session channel until the operator picks another (the
 * sidecar's state file holds it, and every `SET_TRANSPORT(ESPNOW)` and `SET_BRIDGE` carries it),
 * and what a device uses when it has stored none.
 */
export const ESPNOW_CHANNEL = 1;
/**
 * The channels an ESP-NOW rig may use: the firmware's radio country is ZA (channels 1–13) and it
 * refuses any other channel on the wire (mirrors `ESPNOW_CHANNEL_MIN`/`MAX` in `protocol.h`).
 */
export const ESPNOW_CHANNEL_MIN = 1;
export const ESPNOW_CHANNEL_MAX = 13;

/** True for a channel the firmware accepts ({@link ESPNOW_CHANNEL_MIN}–{@link ESPNOW_CHANNEL_MAX}). */
export function isEspnowChannel(channel: number): boolean {
  return Number.isInteger(channel) && channel >= ESPNOW_CHANNEL_MIN && channel <= ESPNOW_CHANNEL_MAX;
}

/**
 * A light that hears no frame from its host this long, on any transport (USB, TCP, the ESP-NOW
 * bridge), treats the link as dead and shows steady blue (enforced by the firmware). The
 * sidecar's keyframe period is derived from it (`app.ts`).
 */
export const HOST_SILENCE_TIMEOUT_MS = 5_000;

// ── Timers ────────────────────────────────────────────────────────────────────
// Firmware-side values mirror `protocol.h`; server-side ones are listed there for reference.

/** How often a device heartbeats once connected over TCP (firmware). */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** How often a device re-broadcasts its discovery request until it finds a server (firmware). */
export const DISCOVERY_INTERVAL_MS = 2_000;
/** Per-device timeout: no message within this window means the device is gone (server). */
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/** How often the server broadcasts its presence (server). */
export const ANNOUNCE_INTERVAL_MS = 5_000;
/**
 * An ESP-NOW light unlinked this long starts hunting channels 1–13 for its bridge; before it,
 * the light only relinks on its stored channel (firmware, v4).
 */
export const CHANNEL_HUNT_AFTER_MS = 10_000;
/** How long a hunting light listens for TALLY_HERE on each channel it tries (firmware, v4). */
export const CHANNEL_DWELL_MS = 150;

/**
 * The bridge's ESP-NOW transmit power, in esp_wifi's quarter-dBm units, as SET_BRIDGE's optional
 * `txPower` byte carries it (v4). FULL is what a bridge uses when the byte is absent; the radio
 * rounds 78 down to 72, so it is really 18 dBm. REDUCED is 8.5 dBm exactly.
 */
export const BRIDGE_TX_POWER = {
  FULL: 78,
  REDUCED: 34,
} as const;

/** WiFi join progress, streamed in STATUS so the wizard confirms a join before unplug. */
export const WifiState = {
  IDLE: 0,
  JOINING: 1,
  CONNECTED: 2,
  FAILED: 3,
} as const;

/** LOG severity. */
export const LogLevel = {
  INFO: 0,
  WARN: 1,
  ERROR: 2,
} as const;

/** A {@link LogLevel} as the name the sidecar's `log` events carry. */
export type LogLevelName = "info" | "warn" | "error";

const LOG_LEVEL_NAME: readonly LogLevelName[] = ["info", "warn", "error"];

/** Name a wire {@link LogLevel}; an unknown level reads as `info`. */
export function logLevelName(level: number): LogLevelName {
  return LOG_LEVEL_NAME[level] ?? "info";
}

// ── Protocol versioning ─────────────────────────────────────────────────────
// HELLO carries the version a device speaks. Backward-compat lives in the server
// (easy to update), not the firmware (flashed onto devices). See docs/architecture.md.

export const PROTOCOL_VERSION = {
  /**
   * The version the server prefers / emits. Bumped 1 → 2 for USB provisioning (a v2
   * HELLO tells the app the firmware understands SET_WIFI/SET_TRANSPORT), then 2 → 3
   * for ESP-NOW: a v3 HELLO means the firmware understands SET_TRANSPORT(ESPNOW),
   * SET_BRIDGE, RELAY (both directions), and emits the STATUS [channel][bridging] bytes, then 3 → 4
   * for channel selection: a v4 HELLO means an ESP-NOW light hunts channels for its bridge, the
   * device answers SCAN_WIFI, and a bridge honours SET_BRIDGE's txPower byte. The app only sends
   * each generation's frames to devices reporting at least that version.
   */
  CURRENT: 4,
  /** The oldest device version the server still handles; below this it warns. */
  MIN_SUPPORTED: 1,
  /**
   * The first version that understands the ESP-NOW frames (SET_TRANSPORT(ESPNOW), SET_BRIDGE,
   * RELAY). The app never sends them to, or offers ESP-NOW for, an older device.
   */
  ESPNOW: 3,
  /**
   * The first version whose lights follow a channel change without a cable, that answers
   * SCAN_WIFI, and that accepts SET_BRIDGE's txPower byte. An older device rejects a 4-byte
   * SET_BRIDGE outright, so it must never be sent one.
   */
  CHANNEL_SELECTION: 4,
} as const;

/**
 * Whether the server can speak this device's dialect, and if not, which side is stale.
 * Devices in [MIN_SUPPORTED, CURRENT] are handled (the server adapts down to older ones);
 * below MIN_SUPPORTED the light needs a firmware update, and a version newer than CURRENT
 * needs this app updated before it's understood.
 */
export type DeviceCompatibility = "supported" | "device-too-old" | "app-too-old";

export function deviceCompatibility(version: number): DeviceCompatibility {
  if (version < PROTOCOL_VERSION.MIN_SUPPORTED) return "device-too-old";
  if (version > PROTOCOL_VERSION.CURRENT) return "app-too-old";
  return "supported";
}

/** Why a device is unsupported: the {@link DeviceCompatibility} values other than "supported". */
export type UnsupportedReason = Exclude<DeviceCompatibility, "supported">;

/** True when a device at this protocol version understands the ESP-NOW frames. */
export function supportsEspNow(version: number): boolean {
  return version >= PROTOCOL_VERSION.ESPNOW;
}

/**
 * True when a device at this protocol version follows a channel change without a cable, answers
 * SCAN_WIFI, and accepts SET_BRIDGE's txPower byte ({@link PROTOCOL_VERSION.CHANNEL_SELECTION}).
 */
export function supportsChannelSelection(version: number): boolean {
  return version >= PROTOCOL_VERSION.CHANNEL_SELECTION;
}

// ── Colours ──────────────────────────────────────────────────────────────────

export interface Color {
  r: number;
  g: number;
  b: number;
}

/** The standard tally state colours (docs/architecture.md "Standard Colours"). */
export const COLORS = {
  live: { r: 255, g: 0, b: 0 },
  preview: { r: 0, g: 255, b: 0 },
  idle: { r: 30, g: 30, b: 30 },
  disconnected: { r: 0, g: 0, b: 255 },
} as const satisfies Record<string, Color>;

/**
 * Colour shown on a connected-but-unassigned device so it's visibly alive and clearly
 * needs configuring (docs/goals.md, decision 5). Full white, which the sidecar streams as a
 * slow "breathe" brightness envelope (`app.ts`; `docs/led.md` state 5), keeping it distinct
 * from steady dim-white idle and the white locate strobe.
 *
 * NB: this is the *unassigned* colour. It is unrelated to the firmware's `COLOR_SETUP`
 * (magenta), which is the device-local *provisioning* hint — keeping the two apart is the
 * whole point, so "needs WiFi setup" and "needs assigning" never look the same (docs/led.md).
 */
export const SETUP_COLOR: Color = { r: 255, g: 255, b: 255 };

/** Default LED brightness; configurable per device in the UI. */
export const DEFAULT_BRIGHTNESS = 128;

// ── Framing ───────────────────────────────────────────────────────────────────

/** Largest payload a single length byte can frame. */
export const MAX_PAYLOAD_BYTES = 255;

/**
 * Prepend the length byte to a payload, producing a complete frame ready to write
 * to the socket. Throws if the payload is too large to length-prefix.
 */
export function frame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new RangeError(
      `payload is ${payload.length} bytes; the length prefix tops out at ${MAX_PAYLOAD_BYTES}`,
    );
  }
  const out = new Uint8Array(payload.length + 1);
  out[0] = payload.length;
  out.set(payload, 1);
  return out;
}

/**
 * Reassembles length-prefixed frames from a TCP byte stream. TCP has no message
 * boundaries, so chunks may split a frame or coalesce several; feed every chunk
 * through `push` and act on the complete payloads it returns. Each returned
 * payload is unframed (the length byte stripped) and starts with its type byte.
 */
export class FrameDecoder {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.length);

    const payloads: Uint8Array[] = [];
    let offset = 0;
    while (offset < merged.length) {
      const len = merged[offset]!;
      if (offset + 1 + len > merged.length) break; // frame not fully arrived yet
      payloads.push(merged.slice(offset + 1, offset + 1 + len));
      offset += 1 + len;
    }
    this.#buffer = merged.slice(offset);
    return payloads;
  }

  /** Bytes buffered so far that don't yet form a complete frame (for tests/diagnostics). */
  get pending(): number {
    return this.#buffer.length;
  }
}

// ── Server → device payloads & encoders ──────────────────────────────────────
// `*Payload` builders produce the unframed `[type][fields…]` body — the unit shared
// across transports. TCP callers wrap one in `frame()` (the `encode*` helpers below);
// the USB path hands the same payload to COBS framing. Keep encoders == frame(payload).

function assertByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${name} must be an integer in 0–255, got ${value}`);
  }
}

function assertEspnowChannel(channel: number): void {
  if (!isEspnowChannel(channel)) {
    throw new RangeError(
      `channel must be an integer in ${ESPNOW_CHANNEL_MIN}–${ESPNOW_CHANNEL_MAX}, got ${channel}`,
    );
  }
}

/** SET_COLOR payload: `[type][R][G][B][brightness]`. */
export function setColorPayload(color: Color, brightness: number = DEFAULT_BRIGHTNESS): Uint8Array {
  assertByte("r", color.r);
  assertByte("g", color.g);
  assertByte("b", color.b);
  assertByte("brightness", brightness);
  return Uint8Array.of(ServerMessageType.SET_COLOR, color.r, color.g, color.b, brightness);
}

/**
 * SET_COLOR (TCP frame) — set the WS2812 LED. `color` is the tally state colour;
 * `brightness` is per-device (defaults to DEFAULT_BRIGHTNESS). Returns a complete frame.
 */
export function encodeSetColor(color: Color, brightness: number = DEFAULT_BRIGHTNESS): Uint8Array {
  return frame(setColorPayload(color, brightness));
}

/**
 * The longest SSID and password SET_WIFI carries, in UTF-8 bytes: 802.11's SSID limit and WPA2's
 * passphrase limit. The firmware's decoder drops a longer one (`protocol.h` mirrors these), so
 * the sidecar and the UI refuse it first, with {@link wifiCredentialsProblem}'s message.
 */
export const WIFI_SSID_MAX_BYTES = 32;
export const WIFI_PASSWORD_MAX_BYTES = 63;

/**
 * Why a light can't take these Wi-Fi credentials, in words for the operator, or null when it can.
 * Limits are bytes, not characters: an accented or non-Latin name uses more than one per character.
 */
export function wifiCredentialsProblem(ssid: string, password: string): string | null {
  const enc = new TextEncoder();
  if (enc.encode(ssid).length > WIFI_SSID_MAX_BYTES) {
    return `The network name is too long: a light takes at most ${WIFI_SSID_MAX_BYTES} bytes (fewer characters if it has accents or symbols).`;
  }
  if (enc.encode(password).length > WIFI_PASSWORD_MAX_BYTES) {
    return `The password is too long: a light takes at most ${WIFI_PASSWORD_MAX_BYTES} bytes (fewer characters if it has accents or symbols).`;
  }
  return null;
}

/**
 * SET_WIFI payload: `[type][ssidLen][ssid…][passLen][pass…]` (USB only). The device
 * persists these creds where WiFiManager reads them and confirms at once (save-only); the
 * join runs in the background and streams as STATUS `wifiState`, never gating the save.
 * SSID/password are UTF-8, within {@link WIFI_SSID_MAX_BYTES} / {@link WIFI_PASSWORD_MAX_BYTES};
 * longer ones throw, since the firmware would drop the frame.
 */
export function setWifiPayload(ssid: string, password: string): Uint8Array {
  const problem = wifiCredentialsProblem(ssid, password);
  if (problem) throw new RangeError(problem);
  const enc = new TextEncoder();
  const ssidBytes = enc.encode(ssid);
  const passBytes = enc.encode(password);
  const out = new Uint8Array(1 + 1 + ssidBytes.length + 1 + passBytes.length);
  let i = 0;
  out[i++] = ServerMessageType.SET_WIFI;
  out[i++] = ssidBytes.length;
  out.set(ssidBytes, i);
  i += ssidBytes.length;
  out[i++] = passBytes.length;
  out.set(passBytes, i);
  return out;
}

/**
 * SET_TRANSPORT payload (USB only). `mode` is a {@link Transport} value. `[type][mode]` for
 * No-TX/WiFi; `[type][mode][channel]` when a channel is given. ESP-NOW requires one (the session
 * channel), so a forgotten channel throws rather than letting the device fall back to
 * {@link ESPNOW_CHANNEL}, which it does when the byte is absent. A channel outside 1–13 throws: the
 * device would ignore the whole frame.
 */
export function setTransportPayload(mode: number, channel?: number): Uint8Array {
  assertByte("mode", mode);
  if (channel === undefined) {
    if (mode === Transport.ESPNOW) throw new RangeError("SET_TRANSPORT(ESPNOW) needs a channel");
    return Uint8Array.of(ServerMessageType.SET_TRANSPORT, mode);
  }
  assertEspnowChannel(channel);
  return Uint8Array.of(ServerMessageType.SET_TRANSPORT, mode, channel);
}

/** GET_STATUS payload: `[type]` (USB only) — ask the device for a STATUS frame. */
export function getStatusPayload(): Uint8Array {
  return Uint8Array.of(ServerMessageType.GET_STATUS);
}

/**
 * RELAY payload: `[type][targetMAC×6][inner…]` (USB only, to a bridge). Wraps an
 * unframed server→device payload for one ESP-NOW light behind the bridge; the bridge
 * strips the 7-byte header and sends `inner` verbatim, never reading it.
 */
export function relayPayload(targetMac: string, inner: Uint8Array): Uint8Array {
  const out = new Uint8Array(7 + inner.length);
  out[0] = ServerMessageType.RELAY;
  out.set(parseMac(targetMac), 1);
  out.set(inner, 7);
  return out;
}

/**
 * SET_BRIDGE payload: `[type][enabled][channel]`, or `[type][enabled][channel][txPower]` when
 * `txPower` is given (USB only). Runtime-only — the sidecar persists the designation and
 * re-asserts it on every USB (re)connect; the device never stores it. `channel` is the ESP-NOW
 * channel to bridge on (the session channel); it's required even when disabling (the device
 * ignores it then), and one outside 1–13 throws (the device would refuse to bridge). `txPower` is the bridge's transmit power in quarter-dBm
 * ({@link BRIDGE_TX_POWER}); absent means full power. Pass it only to a device at
 * {@link PROTOCOL_VERSION.CHANNEL_SELECTION} or later: older firmware rejects a 4-byte SET_BRIDGE.
 */
export function setBridgePayload(enabled: boolean, channel: number, txPower?: number): Uint8Array {
  assertEspnowChannel(channel);
  if (txPower === undefined) {
    return Uint8Array.of(ServerMessageType.SET_BRIDGE, enabled ? 1 : 0, channel);
  }
  assertByte("txPower", txPower);
  return Uint8Array.of(ServerMessageType.SET_BRIDGE, enabled ? 1 : 0, channel, txPower);
}

/** SCAN_WIFI payload: `[type]` (USB only, v4) — ask the device for its SCAN_RESULT frames. */
export function scanWifiPayload(): Uint8Array {
  return Uint8Array.of(ServerMessageType.SCAN_WIFI);
}

// ── Device → server decoder ────────────────────────────────────────────────────

/** A device's HELLO, sent on every (re)connect. */
export interface HelloMessage {
  kind: "hello";
  /** Protocol version the device speaks. */
  version: number;
  /** Colon-separated lower-case MAC, e.g. "aa:bb:cc:dd:ee:ff". */
  mac: string;
}

/** A device's periodic keep-alive. Carries no MAC — the socket is the identity. */
export interface HeartbeatMessage {
  kind: "heartbeat";
}

/** A device's transport/WiFi status, streamed over USB (pushed on change + on GET_STATUS). */
export interface StatusMessage {
  kind: "status";
  /** {@link Transport} value (open enum). */
  transport: number;
  /** {@link WifiState} value. */
  wifiState: number;
  /** Signed RSSI in dBm (0 when not applicable). */
  rssi: number;
  /**
   * The device's stored SSID, read from its NVS (`""` when no creds are saved). This is
   * device-truth — it supersedes the host's own memory, so the SSID stays accurate even
   * for a device the host never provisioned. Replaces the old `credsPresent` bool
   * (`ssid !== ""` carries the same signal).
   */
  ssid: string;
  /**
   * The device's stored ESP-NOW channel (`[channel]`, a v3 addition after the SSID). Null when
   * the byte is absent — pre-v3 firmware that doesn't report one.
   */
  channel: number | null;
  /**
   * True while the device is in bridge mode (the `[bridging]` byte after `[channel]`, non-zero).
   * Both trailing bytes are a v3 addition; absent on older firmware → false.
   */
  bridge: boolean;
}

/** The firmware version a device reports right after its HELLO. */
export interface FirmwareMessage {
  kind: "firmware";
  /** The firmware's semver, e.g. "1.1.0". */
  version: string;
}

/** A framed log line from the device (USB release builds emit these instead of raw text). */
export interface LogMessage {
  kind: "log";
  /** {@link LogLevel} value. */
  level: number;
  text: string;
}

/** One access point a device heard while scanning. */
export interface ScannedAccessPoint {
  /** 2.4 GHz channel the access point is on. */
  channel: number;
  /** Signed RSSI in dBm. */
  rssi: number;
  /** The network name, UTF-8 (`""` for a hidden network). */
  ssid: string;
}

/**
 * One frame of a device's reply to SCAN_WIFI: `[type][index][total][channel][rssi][ssidLen][ssid…]`.
 * A reply is `total` frames with `index` 0 … `total - 1`, one access point each; a scan that
 * found none is a single frame with `total` = `index` = 0, which decodes with `ap` null.
 */
export interface ScanResultMessage {
  kind: "scanResult";
  index: number;
  total: number;
  ap: ScannedAccessPoint | null;
}

/**
 * An ESP-NOW frame a bridge received and forwarded up. `inner` is itself an unframed
 * device→server payload — run it back through {@link decodeDeviceMessage} (the
 * envelope is the only layer the bridge adds).
 */
export interface RelayedMessage {
  kind: "relayed";
  /** STA MAC of the ESP-NOW light that sent `inner` (from the receive callback). */
  srcMac: string;
  inner: Uint8Array;
}

export type DeviceMessage =
  | HelloMessage
  | HeartbeatMessage
  | FirmwareMessage
  | StatusMessage
  | LogMessage
  | RelayedMessage
  | ScanResultMessage;

/**
 * Decode one unframed device→server payload (as produced by {@link FrameDecoder} on TCP,
 * or by COBS deframing on USB). The first byte is the message type. Throws on an unknown
 * type or a payload whose length doesn't match its type. STATUS and SCAN_RESULT only arrive over
 * USB; LOG arrives over USB or relayed from an ESP-NOW light.
 */
export function decodeDeviceMessage(payload: Uint8Array): DeviceMessage {
  if (payload.length === 0) {
    throw new RangeError("empty payload: no message type byte");
  }
  const type = payload[0]!;
  switch (type) {
    case DeviceMessageType.HELLO: {
      // [type][version][MAC×6] — 8 payload bytes
      if (payload.length !== 8) {
        throw new RangeError(`HELLO payload must be 8 bytes, got ${payload.length}`);
      }
      return { kind: "hello", version: payload[1]!, mac: formatMac(payload.subarray(2, 8)) };
    }
    case DeviceMessageType.HEARTBEAT: {
      // [type] — 1 payload byte
      if (payload.length !== 1) {
        throw new RangeError(`HEARTBEAT payload must be 1 byte, got ${payload.length}`);
      }
      return { kind: "heartbeat" };
    }
    case DeviceMessageType.STATUS: {
      // [type][transport][wifiState][rssi][ssidLen][ssid…][channel][bridging] — ≥ 5 payload
      // bytes (ssidLen is always present, 0 when the device has no stored creds; the two
      // trailing bytes are a v3 addition — absent on older firmware, per the skip-trailing
      // rule). A v3 device always sends both; if only one is present we read it as the
      // channel with bridging off (lenient decoding).
      if (payload.length < 5) {
        throw new RangeError(`STATUS payload must be at least 5 bytes, got ${payload.length}`);
      }
      const ssidLen = payload[4]!;
      if (payload.length < 5 + ssidLen) {
        throw new RangeError(`STATUS SSID truncated: need ${5 + ssidLen} bytes, got ${payload.length}`);
      }
      const tail = 5 + ssidLen;
      const channel = payload.length > tail ? payload[tail]! : null;
      const bridge = payload.length > tail + 1 ? payload[tail + 1]! !== 0 : false;
      return {
        kind: "status",
        transport: payload[1]!,
        wifiState: payload[2]!,
        rssi: (payload[3]! << 24) >> 24, // sign-extend the byte
        ssid: new TextDecoder().decode(payload.subarray(5, tail)),
        channel,
        bridge,
      };
    }
    case DeviceMessageType.LOG: {
      // [type][level][utf8…] — 2+ payload bytes
      if (payload.length < 2) {
        throw new RangeError(`LOG payload must be at least 2 bytes, got ${payload.length}`);
      }
      return { kind: "log", level: payload[1]!, text: new TextDecoder().decode(payload.subarray(2)) };
    }
    case DeviceMessageType.RELAY: {
      // [type][srcMAC×6][inner…] — the inner payload must at least carry a type byte
      if (payload.length < 8) {
        throw new RangeError(`RELAY payload must be at least 8 bytes, got ${payload.length}`);
      }
      return {
        kind: "relayed",
        srcMac: formatMac(payload.subarray(1, 7)),
        inner: payload.slice(7),
      };
    }
    case DeviceMessageType.SCAN_RESULT: {
      // [type][index][total][channel][rssi][ssidLen][ssid…] — ≥ 6 payload bytes
      if (payload.length < 6) {
        throw new RangeError(`SCAN_RESULT payload must be at least 6 bytes, got ${payload.length}`);
      }
      const ssidLen = payload[5]!;
      if (payload.length !== 6 + ssidLen) {
        throw new RangeError(`SCAN_RESULT payload must be ${6 + ssidLen} bytes, got ${payload.length}`);
      }
      const index = payload[1]!;
      const total = payload[2]!;
      if (total === 0) {
        if (index !== 0) throw new RangeError(`SCAN_RESULT with total 0 must have index 0, got ${index}`);
        return { kind: "scanResult", index, total, ap: null };
      }
      if (index >= total) {
        throw new RangeError(`SCAN_RESULT index ${index} is not below total ${total}`);
      }
      return {
        kind: "scanResult",
        index,
        total,
        ap: {
          channel: payload[3]!,
          rssi: (payload[4]! << 24) >> 24, // sign-extend the byte
          ssid: new TextDecoder().decode(payload.subarray(6)),
        },
      };
    }
    case DeviceMessageType.FIRMWARE: {
      // [type][utf8 version…]
      if (payload.length < 2) {
        throw new RangeError(`FIRMWARE payload must be at least 2 bytes, got ${payload.length}`);
      }
      return { kind: "firmware", version: new TextDecoder().decode(payload.subarray(1)) };
    }
    default:
      throw new RangeError(`unknown device message type 0x${type.toString(16).padStart(2, "0")}`);
  }
}

// ── MAC helpers ────────────────────────────────────────────────────────────────

/** Six raw MAC bytes → "aa:bb:cc:dd:ee:ff" (lower-case). */
export function formatMac(bytes: Uint8Array): string {
  if (bytes.length !== 6) {
    throw new RangeError(`MAC must be 6 bytes, got ${bytes.length}`);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(":");
}

/** A full MAC: six colon-separated two-hex-digit octets (any case), e.g. `e8:3d:c1:85:dc:6c`. */
export function isMac(mac: string): boolean {
  return /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(mac);
}

/** "aa:bb:cc:dd:ee:ff" (any case) → six raw MAC bytes. Inverse of {@link formatMac}. */
export function parseMac(mac: string): Uint8Array {
  if (!isMac(mac)) throw new RangeError(`not a MAC address: "${mac}"`);
  return Uint8Array.from(mac.split(":"), (p) => Number.parseInt(p, 16));
}

/**
 * The short MAC tail shown in the UI to tell devices apart (docs/goals.md). Defaults
 * to the last 3 octets, e.g. "aa:bb:cc:dd:ee:ff" → "dd:ee:ff".
 */
export function macTail(mac: string, octets = 3): string {
  return mac.split(":").slice(-octets).join(":");
}

// ── Discovery (UDP, text datagrams) ─────────────────────────────────────────────
// Devices broadcast DISCOVERY_REQUEST; the server replies/broadcasts a response
// carrying its TCP port. Callers pass the datagram decoded to a string.

/** What a device broadcasts to find the server. */
export const DISCOVERY_REQUEST = "TALLY_FIND";
/** Prefix of the server's reply; the TCP port follows, e.g. "TALLY_HERE:7000". */
export const DISCOVERY_RESPONSE_PREFIX = "TALLY_HERE:";

/** Build the server's discovery reply, advertising its TCP port. */
export function encodeDiscoveryResponse(port: number = SERVER_PORT): string {
  return `${DISCOVERY_RESPONSE_PREFIX}${port}`;
}

/** True if a received datagram is a device's discovery request. */
export function isDiscoveryRequest(message: string): boolean {
  return message === DISCOVERY_REQUEST;
}

/** Parse a server discovery reply, returning its advertised port, or null if it isn't one. */
export function parseDiscoveryResponse(message: string): { port: number } | null {
  if (!message.startsWith(DISCOVERY_RESPONSE_PREFIX)) return null;
  const port = Number(message.slice(DISCOVERY_RESPONSE_PREFIX.length));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port };
}

/**
 * A dotted-quad IPv4 address, each octet 0–255, e.g. `192.168.10.240` — the form the ATEM
 * source IP takes. Shared by the settings form and the sidecar's `setSource` handler.
 */
export function isIPv4(ip: string): boolean {
  const octets = ip.split(".");
  return octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

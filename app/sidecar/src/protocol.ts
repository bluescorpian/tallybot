/**
 * Binary device↔server wire protocol — the server (sidecar) side.
 *
 * Source of truth: `ARCHITECTURE.md` ("Binary Message Protocol"). These values
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
// HELLO/HEARTBEAT/SET_COLOR/IDENTIFY travel over both transports; the rest are
// USB-only provisioning/diagnostics frames (a USB device is by definition new
// enough to speak them — see the versioning note below).

/** Device → server (a.k.a. device → host) message types. */
export const DeviceMessageType = {
  HELLO: 0x01,
  HEARTBEAT: 0x02,
  /** Transport/WiFi status snapshot, pushed on change and in reply to GET_STATUS (USB). */
  STATUS: 0x03,
  /** A framed log line — replaces raw Serial.print on release firmware (USB). */
  LOG: 0x04,
  /** WiFi scan result. Reserved; deferred post-v1.2 (the user types the SSID for now). */
  SCAN_RESULT: 0x05,
} as const;

/** Server → device (a.k.a. host → device) message types. */
export const ServerMessageType = {
  SET_COLOR: 0x01,
  IDENTIFY: 0x02,
  /** Persist WiFi creds + trigger a validating join attempt (USB). */
  SET_WIFI: 0x03,
  /** Persist the transport mode (No-TX / WiFi) (USB). */
  SET_TRANSPORT: 0x04,
  /** Request a STATUS frame (USB). */
  GET_STATUS: 0x05,
  /** Request a WiFi scan → SCAN_RESULT. Reserved; deferred post-v1.2. */
  SCAN_WIFI: 0x06,
  /** v1.3 ESP-NOW bridge relay `[type][targetMAC×6][inner…]`. Reserved; unimplemented. */
  RELAY: 0x07,
} as const;

// ── Shared field enums (used inside the payloads above) ──────────────────────

/**
 * How a device reaches the server when unplugged. **Open enum** — store as an int
 * everywhere (NVS, wire byte, IPC), never a bool: v1.3 adds `2 = ESP-NOW`.
 */
export const Transport = {
  NOTX: 0,
  WIFI: 1,
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

// ── Protocol versioning ─────────────────────────────────────────────────────
// HELLO carries the version a device speaks. Backward-compat lives in the server
// (easy to update), not the firmware (flashed onto devices). See ARCHITECTURE.md.

export const PROTOCOL_VERSION = {
  /**
   * The version the server prefers / emits. Bumped 1 → 2 for USB provisioning: a v2
   * HELLO tells the app the firmware understands SET_WIFI/SET_TRANSPORT, so the app
   * only sends those to a device reporting version ≥ 2. (Those frames only ever travel
   * over USB anyway, where the firmware is by definition new.)
   */
  CURRENT: 2,
  /** The oldest device version the server still handles; below this it warns. */
  MIN_SUPPORTED: 1,
} as const;

/**
 * True when the server can speak this device's dialect. Devices in
 * [MIN_SUPPORTED, CURRENT] are handled (the server adapts down to older ones);
 * below MIN_SUPPORTED the server surfaces an "update firmware" warning, and a
 * version newer than CURRENT needs a server update before it's understood.
 */
export function isSupportedVersion(version: number): boolean {
  return version >= PROTOCOL_VERSION.MIN_SUPPORTED && version <= PROTOCOL_VERSION.CURRENT;
}

// ── Colours ──────────────────────────────────────────────────────────────────

export interface Color {
  r: number;
  g: number;
  b: number;
}

/** The standard tally state colours (ARCHITECTURE.md "Standard Colours"). */
export const COLORS = {
  live: { r: 255, g: 0, b: 0 },
  preview: { r: 0, g: 255, b: 0 },
  idle: { r: 30, g: 30, b: 30 },
  disconnected: { r: 0, g: 0, b: 255 },
} as const satisfies Record<string, Color>;

/**
 * Colour shown on a connected-but-unassigned device so it's visibly alive and clearly
 * needs configuring (GOALS.md, decision 5). Full white: the firmware renders it as a slow
 * "breathe" locally (the wire SET_COLOR is static — see `docs/led.md` state 5), which keeps
 * it distinct from steady dim-white idle and the IDENTIFY flash burst.
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

/** IDENTIFY payload: `[type]`. */
export function identifyPayload(): Uint8Array {
  return Uint8Array.of(ServerMessageType.IDENTIFY);
}

/** IDENTIFY (TCP frame) — flash the device briefly so the user can physically locate it. */
export function encodeIdentify(): Uint8Array {
  return frame(identifyPayload());
}

/**
 * SET_WIFI payload: `[type][ssidLen][ssid…][passLen][pass…]` (USB only). The device
 * persists these creds where WiFiManager reads them and attempts a validating join.
 * SSID/password are UTF-8; each length is a single byte (the lengths the firmware and
 * NVS accept comfortably bound this — SSID ≤ 32, WPA pass ≤ 63).
 */
export function setWifiPayload(ssid: string, password: string): Uint8Array {
  const enc = new TextEncoder();
  const ssidBytes = enc.encode(ssid);
  const passBytes = enc.encode(password);
  assertByte("ssidLen", ssidBytes.length);
  assertByte("passLen", passBytes.length);
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

/** SET_TRANSPORT payload: `[type][mode]` (USB only). `mode` is a {@link Transport} value. */
export function setTransportPayload(mode: number): Uint8Array {
  assertByte("mode", mode);
  return Uint8Array.of(ServerMessageType.SET_TRANSPORT, mode);
}

/** GET_STATUS payload: `[type]` (USB only) — ask the device for a STATUS frame. */
export function getStatusPayload(): Uint8Array {
  return Uint8Array.of(ServerMessageType.GET_STATUS);
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
}

/** A framed log line from the device (USB release builds emit these instead of raw text). */
export interface LogMessage {
  kind: "log";
  /** {@link LogLevel} value. */
  level: number;
  text: string;
}

export type DeviceMessage = HelloMessage | HeartbeatMessage | StatusMessage | LogMessage;

/**
 * Decode one unframed device→server payload (as produced by {@link FrameDecoder} on TCP,
 * or by COBS deframing on USB). The first byte is the message type. Throws on an unknown
 * type or a payload whose length doesn't match its type. STATUS/LOG only arrive over USB.
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
      // [type][transport][wifiState][rssi][ssidLen][ssid…] — ≥ 5 payload bytes
      // (ssidLen is always present, 0 when the device has no stored creds).
      if (payload.length < 5) {
        throw new RangeError(`STATUS payload must be at least 5 bytes, got ${payload.length}`);
      }
      const ssidLen = payload[4]!;
      if (payload.length < 5 + ssidLen) {
        throw new RangeError(`STATUS SSID truncated: need ${5 + ssidLen} bytes, got ${payload.length}`);
      }
      return {
        kind: "status",
        transport: payload[1]!,
        wifiState: payload[2]!,
        rssi: (payload[3]! << 24) >> 24, // sign-extend the byte
        ssid: new TextDecoder().decode(payload.subarray(5, 5 + ssidLen)),
      };
    }
    case DeviceMessageType.LOG: {
      // [type][level][utf8…] — 2+ payload bytes
      if (payload.length < 2) {
        throw new RangeError(`LOG payload must be at least 2 bytes, got ${payload.length}`);
      }
      return { kind: "log", level: payload[1]!, text: new TextDecoder().decode(payload.subarray(2)) };
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

/**
 * The short MAC tail shown in the UI to tell devices apart (GOALS.md). Defaults
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

/**
 * Binary device↔server wire protocol — the server (sidecar) side.
 *
 * Source of truth: `ARCHITECTURE.md` ("Binary Message Protocol"). These values
 * mirror the firmware `#define`s in `firmware/src/main.cpp`; keep the two in sync.
 *
 * Framing: every message is length-prefixed — a single leading byte gives the
 * number of payload bytes that follow, and the first payload byte is the message
 * type. One uniform loop frames any message regardless of length, which is what
 * lets a parser skip a message (or trailing fields) it doesn't recognise.
 *
 *   [len][payload …]      len = count of payload bytes that follow (1 byte, 0–255)
 */

// ── Network ports ───────────────────────────────────────────────────────────

/** TCP server devices connect to (the stable endpoint). */
export const SERVER_PORT = 7000;
/** UDP port used for broadcast discovery in both directions. */
export const DISCOVERY_PORT = 7001;

// ── Message types (the first payload byte) ──────────────────────────────────
// Device→server and server→device type spaces are independent; both start at 0x01.

/** Device → server message types. */
export const DeviceMessageType = {
  HELLO: 0x01,
  HEARTBEAT: 0x02,
} as const;

/** Server → device message types. */
export const ServerMessageType = {
  SET_COLOR: 0x01,
  IDENTIFY: 0x02,
} as const;

// ── Protocol versioning ─────────────────────────────────────────────────────
// HELLO carries the version a device speaks. Backward-compat lives in the server
// (easy to update), not the firmware (flashed onto devices). See ARCHITECTURE.md.

export const PROTOCOL_VERSION = {
  /** The version the server prefers / emits. */
  CURRENT: 1,
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
 * Colour shown on a connected-but-unassigned device so it's visibly alive and
 * clearly needs configuring (GOALS.md, decision 5).
 *
 * TODO(GOALS.md "Still to decide"): the exact setup colour isn't decided yet.
 * Provisional value: magenta — distinct from every state colour above.
 */
export const SETUP_COLOR: Color = { r: 255, g: 0, b: 255 };

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

// ── Server → device encoders ───────────────────────────────────────────────────

function assertByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${name} must be an integer in 0–255, got ${value}`);
  }
}

/**
 * SET_COLOR — set the WS2812 LED. `color` is the tally state colour; `brightness`
 * is per-device (defaults to DEFAULT_BRIGHTNESS). Returns a complete frame.
 */
export function encodeSetColor(color: Color, brightness: number = DEFAULT_BRIGHTNESS): Uint8Array {
  assertByte("r", color.r);
  assertByte("g", color.g);
  assertByte("b", color.b);
  assertByte("brightness", brightness);
  return frame(Uint8Array.of(ServerMessageType.SET_COLOR, color.r, color.g, color.b, brightness));
}

/** IDENTIFY — flash the device briefly so the user can physically locate it. */
export function encodeIdentify(): Uint8Array {
  return frame(Uint8Array.of(ServerMessageType.IDENTIFY));
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

export type DeviceMessage = HelloMessage | HeartbeatMessage;

/**
 * Decode one unframed device→server payload (as produced by {@link FrameDecoder}).
 * The first byte is the message type. Throws on an unknown type or a payload whose
 * length doesn't match its type.
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

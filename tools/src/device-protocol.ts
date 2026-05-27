/**
 * The **device** side of the binary wire protocol — the mirror of the sidecar's
 * server-side `app/sidecar/src/protocol.ts`.
 *
 * `protocol.ts` is deliberately the *server* half: it encodes server→device
 * (SET_COLOR / IDENTIFY) and decodes device→server (HELLO / HEARTBEAT). A
 * simulated device needs the opposite — encode HELLO/HEARTBEAT, decode
 * SET_COLOR/IDENTIFY — so that half lives here. The two reference the **same**
 * constants, framing, and `FrameDecoder` from `protocol.ts`, so there is one
 * source of truth for the wire format; only the direction differs.
 *
 * This is the TypeScript counterpart of what the ESP32 firmware (Phase 3)
 * implements in C++. Keep all three (this file, `protocol.ts`, the firmware
 * `#define`s) consistent with `ARCHITECTURE.md`.
 */

import {
  type Color,
  COLORS,
  DeviceMessageType,
  PROTOCOL_VERSION,
  SETUP_COLOR,
  ServerMessageType,
  formatMac,
  frame,
} from "../../app/sidecar/src/protocol.ts";
import { randomBytes } from "node:crypto";

// Re-exported so a simulated device imports its whole wire surface from one
// module (the codec here + the shared framing it sits on).
export { FrameDecoder } from "../../app/sidecar/src/protocol.ts";

// ── MAC helpers ─────────────────────────────────────────────────────────────

/** Parse "aa:bb:cc:dd:ee:ff" into its six raw bytes. Inverse of {@link formatMac}. */
export function parseMac(mac: string): Uint8Array {
  const octets = mac.split(":");
  if (octets.length !== 6) {
    throw new RangeError(`MAC must have 6 colon-separated octets, got ${octets.length} in "${mac}"`);
  }
  const bytes = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    const octet = octets[i]!;
    if (!/^[0-9a-fA-F]{2}$/.test(octet)) {
      throw new RangeError(`MAC octet "${octet}" is not two hex digits in "${mac}"`);
    }
    bytes[i] = Number.parseInt(octet, 16);
  }
  return bytes;
}

/**
 * A random MAC for a simulated device, in colon form. The first octet is forced
 * to **locally administered + unicast** so a generated address can never collide
 * with a real vendor-assigned one.
 */
export function randomMac(): string {
  const bytes = randomBytes(6);
  bytes[0] = (bytes[0]! & 0b1111_1100) | 0b0000_0010;
  return formatMac(bytes);
}

// ── Device → server encoders ──────────────────────────────────────────────────

/**
 * HELLO — sent immediately on every (re)connect. Carries the device's MAC and the
 * protocol version it speaks: `[type][version][MAC×6]`. Returns a complete frame.
 */
export function encodeHello(mac: string, version: number = PROTOCOL_VERSION.CURRENT): Uint8Array {
  if (!Number.isInteger(version) || version < 0 || version > 255) {
    throw new RangeError(`protocol version must be a byte (0–255), got ${version}`);
  }
  return frame(Uint8Array.of(DeviceMessageType.HELLO, version, ...parseMac(mac)));
}

/** HEARTBEAT — the periodic keep-alive. Carries no MAC; the socket is the identity. */
export function encodeHeartbeat(): Uint8Array {
  return frame(Uint8Array.of(DeviceMessageType.HEARTBEAT));
}

// ── Server → device decoder ─────────────────────────────────────────────────────

/** SET_COLOR — set the LED to a tally colour at a brightness. */
export interface SetColorMessage {
  kind: "setColor";
  color: Color;
  brightness: number;
}

/** IDENTIFY — flash so the operator can physically locate this device. */
export interface IdentifyMessage {
  kind: "identify";
}

export type ServerMessage = SetColorMessage | IdentifyMessage;

/**
 * Decode one unframed server→device payload (as produced by {@link FrameDecoder}).
 * The first byte is the message type. Throws on an unknown type or a payload whose
 * length doesn't match its type — the device's mirror of `decodeDeviceMessage`.
 */
export function decodeServerMessage(payload: Uint8Array): ServerMessage {
  if (payload.length === 0) {
    throw new RangeError("empty payload: no message type byte");
  }
  const type = payload[0]!;
  switch (type) {
    case ServerMessageType.SET_COLOR: {
      // [type][R][G][B][brightness] — 5 payload bytes
      if (payload.length !== 5) {
        throw new RangeError(`SET_COLOR payload must be 5 bytes, got ${payload.length}`);
      }
      return {
        kind: "setColor",
        color: { r: payload[1]!, g: payload[2]!, b: payload[3]! },
        brightness: payload[4]!,
      };
    }
    case ServerMessageType.IDENTIFY: {
      // [type] — 1 payload byte
      if (payload.length !== 1) {
        throw new RangeError(`IDENTIFY payload must be 1 byte, got ${payload.length}`);
      }
      return { kind: "identify" };
    }
    default:
      throw new RangeError(`unknown server message type 0x${type.toString(16).padStart(2, "0")}`);
  }
}

// ── Colour naming (for legible logs) ────────────────────────────────────────────

const NAMED_COLORS: ReadonlyArray<readonly [string, Color]> = [
  ["live", COLORS.live],
  ["preview", COLORS.preview],
  ["idle", COLORS.idle],
  ["disconnected", COLORS.disconnected],
  ["setup", SETUP_COLOR],
];

/**
 * Reverse-lookup a colour to its tally-state name (live/preview/idle/…), or null
 * if it isn't one of the standard colours. Lets the client log "live" instead of
 * a bare RGB triple.
 */
export function colorName(color: Color): string | null {
  for (const [name, c] of NAMED_COLORS) {
    if (c.r === color.r && c.g === color.g && c.b === color.b) return name;
  }
  return null;
}

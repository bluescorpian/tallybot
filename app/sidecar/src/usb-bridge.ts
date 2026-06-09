/**
 * The **internal** shell↔sidecar USB bridge vocabulary.
 *
 * This is a different axis from `ipc.ts` (which is the *UI*↔sidecar contract). The
 * Tauri Rust shell owns the serial port and is a near-dumb byte pipe (`app/src-tauri/
 * src/usb/`): it COBS-frames, parses only HELLO, and exchanges these one-line JSON
 * messages with the sidecar over the *same* stdin/stdout pipe the UI bridge uses.
 *
 * Device→host payloads ride opaque as `payloadHex` and are decoded here with the
 * shared `protocol.ts` codecs — keeping the sidecar the single payload-codec authority
 * and the shell a thin proxy. Outbound, the sidecar hands the shell a `payloadHex` it
 * built with the same codecs; the shell only applies the COBS wrapper.
 */

import { type DeviceMessage, decodeDeviceMessage } from "./protocol.ts";

// ── shell → sidecar (arrives on the sidecar's stdin) ─────────────────────────────

/** A flashed device announced itself (HELLO) on a USB port. */
export interface UsbDeviceConnected {
  type: "usbDeviceConnected";
  mac: string;
  version: number;
}

/** A USB device's port closed — the host-side liveness signal (USB has no HEARTBEAT). */
export interface UsbDeviceDisconnected {
  type: "usbDeviceDisconnected";
  mac: string;
}

/** An opaque device→host payload (STATUS/LOG/…), hex-encoded; decoded with `protocol.ts`. */
export interface UsbFrame {
  type: "usbFrame";
  mac: string;
  payloadHex: string;
}

/** An ESP32-C3 that didn't speak HELLO within the detect window (likely unflashed). */
export interface UsbUnflashed {
  type: "unflashedDeviceDetected";
  port: string;
}

export type UsbInbound = UsbDeviceConnected | UsbDeviceDisconnected | UsbFrame | UsbUnflashed;

// ── sidecar → shell (written on the sidecar's stdout, intercepted before the UI) ──

/** A host→device payload (SET_COLOR/IDENTIFY/SET_WIFI/…), hex-encoded, to COBS-frame + write. */
export interface UsbSend {
  type: "usbSend";
  mac: string;
  payloadHex: string;
}

export type UsbOutbound = UsbSend;

// ── (de)serialisation ─────────────────────────────────────────────────────────────

const INBOUND_TYPES = new Set<string>([
  "usbDeviceConnected",
  "usbDeviceDisconnected",
  "usbFrame",
  "unflashedDeviceDetected",
]);

/** Parse one NDJSON line as a USB bridge inbound message, or null if it isn't one. */
export function parseUsbInbound(line: string): UsbInbound | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && INBOUND_TYPES.has(type) ? (value as UsbInbound) : null;
}

/** Hex-encode a payload for transport over the bridge. */
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Decode a `payloadHex` string back to bytes; throws on a malformed hex string. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new RangeError(`odd-length hex string: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new RangeError(`invalid hex at ${i * 2}: "${hex}"`);
    out[i] = byte;
  }
  return out;
}

/** Decode a `usbFrame`'s opaque payload into a typed device→host message. */
export function decodeUsbFrame(frame: UsbFrame): DeviceMessage {
  return decodeDeviceMessage(fromHex(frame.payloadHex));
}

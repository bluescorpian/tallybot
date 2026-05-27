import { test } from "node:test";
import assert from "node:assert/strict";

// The server half of the same wire protocol. Decoding what this file encodes
// (and vice versa) through the *real* sidecar codec is the point of these tests:
// they prove the device side and the server side agree on the bytes.
import {
  COLORS,
  DEFAULT_BRIGHTNESS,
  SETUP_COLOR,
  decodeDeviceMessage,
  encodeIdentify,
  encodeSetColor,
  formatMac,
} from "../../app/sidecar/src/protocol.ts";

import {
  FrameDecoder,
  colorName,
  decodeServerMessage,
  encodeHeartbeat,
  encodeHello,
  parseMac,
  randomMac,
} from "./device-protocol.ts";

/** Frame → decode the single payload back out, mirroring how a socket reader works. */
function unframe(wire: Uint8Array): Uint8Array {
  const [payload] = new FrameDecoder().push(wire);
  assert.ok(payload, "expected exactly one complete frame");
  return payload;
}

// ── Device → server, decoded by the real server codec ───────────────────────────

test("encodeHello round-trips through the sidecar's decodeDeviceMessage", () => {
  const wire = encodeHello("aa:bb:cc:dd:ee:ff", 1);
  assert.deepEqual(decodeDeviceMessage(unframe(wire)), {
    kind: "hello",
    version: 1,
    mac: "aa:bb:cc:dd:ee:ff",
  });
});

test("encodeHello defaults to the current protocol version", () => {
  const msg = decodeDeviceMessage(unframe(encodeHello("01:23:45:67:89:ab")));
  assert.equal(msg.kind, "hello");
  assert.equal((msg as { version: number }).version, 1);
});

test("encodeHello rejects a version that isn't a byte", () => {
  assert.throws(() => encodeHello("aa:bb:cc:dd:ee:ff", 256), RangeError);
  assert.throws(() => encodeHello("aa:bb:cc:dd:ee:ff", -1), RangeError);
});

test("encodeHeartbeat round-trips through the sidecar's decodeDeviceMessage", () => {
  assert.deepEqual(decodeDeviceMessage(unframe(encodeHeartbeat())), { kind: "heartbeat" });
});

// ── Server → device, encoded by the real server codec ───────────────────────────

test("decodeServerMessage reads a SET_COLOR the sidecar encoded", () => {
  const wire = encodeSetColor(COLORS.preview, 64);
  assert.deepEqual(decodeServerMessage(unframe(wire)), {
    kind: "setColor",
    color: { r: 255, g: 180, b: 0 },
    brightness: 64,
  });
});

test("decodeServerMessage sees the default brightness when the sidecar omits it", () => {
  const msg = decodeServerMessage(unframe(encodeSetColor(COLORS.live)));
  assert.equal((msg as { brightness: number }).brightness, DEFAULT_BRIGHTNESS);
});

test("decodeServerMessage reads an IDENTIFY the sidecar encoded", () => {
  assert.deepEqual(decodeServerMessage(unframe(encodeIdentify())), { kind: "identify" });
});

test("decodeServerMessage rejects malformed payloads", () => {
  assert.throws(() => decodeServerMessage(new Uint8Array(0)), RangeError); // no type byte
  assert.throws(() => decodeServerMessage(Uint8Array.of(0x01, 1, 2, 3)), RangeError); // short SET_COLOR
  assert.throws(() => decodeServerMessage(Uint8Array.of(0x02, 0)), RangeError); // long IDENTIFY
  assert.throws(() => decodeServerMessage(Uint8Array.of(0x7f)), RangeError); // unknown type
});

// ── MAC helpers ────────────────────────────────────────────────────────────────

test("parseMac is the inverse of formatMac", () => {
  const bytes = Uint8Array.of(0x00, 0x1a, 0xb2, 0xc3, 0xd4, 0xe5);
  assert.deepEqual(parseMac(formatMac(bytes)), bytes);
});

test("parseMac rejects malformed MACs", () => {
  assert.throws(() => parseMac("aa:bb:cc:dd:ee"), RangeError); // too few octets
  assert.throws(() => parseMac("aa:bb:cc:dd:ee:ff:00"), RangeError); // too many
  assert.throws(() => parseMac("aa:bb:cc:dd:ee:zz"), RangeError); // not hex
});

test("randomMac is locally-administered, unicast, and parseable", () => {
  for (let i = 0; i < 32; i++) {
    const mac = randomMac();
    const first = parseMac(mac)[0]!;
    assert.equal(first & 0b0000_0010, 0b0000_0010, "locally-administered bit set");
    assert.equal(first & 0b0000_0001, 0, "unicast bit clear");
  }
});

// ── Colour naming ────────────────────────────────────────────────────────────────

test("colorName maps the standard colours and the setup colour", () => {
  assert.equal(colorName(COLORS.live), "live");
  assert.equal(colorName(COLORS.preview), "preview");
  assert.equal(colorName(COLORS.idle), "idle");
  assert.equal(colorName(COLORS.disconnected), "disconnected");
  assert.equal(colorName(SETUP_COLOR), "setup");
  assert.equal(colorName({ r: 1, g: 2, b: 3 }), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLORS,
  DEFAULT_BRIGHTNESS,
  DISCOVERY_REQUEST,
  DeviceMessageType,
  ESPNOW_CHANNEL,
  FrameDecoder,
  LogLevel,
  PROTOCOL_VERSION,
  ServerMessageType,
  Transport,
  WifiState,
  decodeDeviceMessage,
  encodeDiscoveryResponse,
  encodeSetColor,
  formatMac,
  frame,
  getStatusPayload,
  isDiscoveryRequest,
  isSupportedVersion,
  macTail,
  parseDiscoveryResponse,
  parseMac,
  relayPayload,
  setBridgePayload,
  setColorPayload,
  setTransportPayload,
  setWifiPayload,
} from "./protocol.ts";

// ── Framing ───────────────────────────────────────────────────────────────────

test("frame prepends the payload length", () => {
  assert.deepEqual(frame(Uint8Array.of(0xaa, 0xbb)), Uint8Array.of(2, 0xaa, 0xbb));
  assert.deepEqual(frame(new Uint8Array(0)), Uint8Array.of(0));
});

test("frame rejects payloads too large to length-prefix", () => {
  assert.doesNotThrow(() => frame(new Uint8Array(255)));
  assert.throws(() => frame(new Uint8Array(256)), RangeError);
});

test("FrameDecoder yields one payload per frame, length byte stripped", () => {
  const decoder = new FrameDecoder();
  const payloads = decoder.push(frame(Uint8Array.of(0x01, 0x02, 0x03)));
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], Uint8Array.of(0x01, 0x02, 0x03));
  assert.equal(decoder.pending, 0);
});

test("FrameDecoder reassembles a frame split across chunks, one byte at a time", () => {
  const decoder = new FrameDecoder();
  const wire = encodeSetColor(COLORS.live, 200);
  const collected: Uint8Array[] = [];
  for (const byte of wire) {
    collected.push(...decoder.push(Uint8Array.of(byte)));
  }
  assert.equal(collected.length, 1);
  assert.deepEqual(collected[0], wire.subarray(1)); // payload == frame minus length byte
  assert.equal(decoder.pending, 0);
});

test("FrameDecoder splits multiple frames coalesced into one chunk", () => {
  const decoder = new FrameDecoder();
  const a = encodeSetColor(COLORS.live);
  const b = encodeSetColor(COLORS.idle);
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);

  const payloads = decoder.push(merged);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], a.subarray(1));
  assert.deepEqual(payloads[1], b.subarray(1));
});

test("FrameDecoder holds an incomplete frame until the rest arrives", () => {
  const decoder = new FrameDecoder();
  const wire = encodeSetColor(COLORS.preview);
  assert.deepEqual(decoder.push(wire.subarray(0, 3)), []); // partial
  assert.ok(decoder.pending > 0);
  const payloads = decoder.push(wire.subarray(3));
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], wire.subarray(1));
});

// ── Server → device encoders ───────────────────────────────────────────────────

test("encodeSetColor frames [type][r][g][b][brightness]", () => {
  assert.deepEqual(
    encodeSetColor({ r: 255, g: 180, b: 0 }, 64),
    Uint8Array.of(5, ServerMessageType.SET_COLOR, 255, 180, 0, 64),
  );
});

test("encodeSetColor defaults brightness to DEFAULT_BRIGHTNESS", () => {
  const wire = encodeSetColor(COLORS.live);
  assert.equal(wire.at(-1), DEFAULT_BRIGHTNESS);
});

test("encodeSetColor rejects out-of-range channels", () => {
  assert.throws(() => encodeSetColor({ r: 256, g: 0, b: 0 }), RangeError);
  assert.throws(() => encodeSetColor(COLORS.live, 300), RangeError);
  assert.throws(() => encodeSetColor({ r: 0, g: -1, b: 0 }), RangeError);
  assert.throws(() => encodeSetColor({ r: 0, g: 0, b: 1.5 }), RangeError);
});

// ── Shared payload builders (the unframed body — wrapped by TCP frame() or USB COBS) ──

test("encodeSetColor == frame(setColorPayload) — TCP wraps the shared payload", () => {
  const payload = setColorPayload({ r: 255, g: 180, b: 0 }, 64);
  assert.deepEqual(payload, Uint8Array.of(ServerMessageType.SET_COLOR, 255, 180, 0, 64));
  assert.deepEqual(encodeSetColor({ r: 255, g: 180, b: 0 }, 64), frame(payload));
});

test("setWifiPayload lays out [type][ssidLen][ssid][passLen][pass]", () => {
  assert.deepEqual(
    setWifiPayload("Net", "pw12"),
    Uint8Array.of(ServerMessageType.SET_WIFI, 3, 0x4e, 0x65, 0x74, 4, 0x70, 0x77, 0x31, 0x32),
  );
});

test("setWifiPayload handles empty creds and UTF-8 byte length (not char length)", () => {
  assert.deepEqual(setWifiPayload("", ""), Uint8Array.of(ServerMessageType.SET_WIFI, 0, 0));
  // "é" is 2 UTF-8 bytes — the length byte must count bytes, not code points.
  const wire = setWifiPayload("é", "");
  assert.equal(wire[1], 2);
});

test("setTransportPayload / getStatusPayload", () => {
  // No-TX/WiFi: bare [type][mode], no channel byte.
  assert.deepEqual(setTransportPayload(Transport.NOTX), Uint8Array.of(ServerMessageType.SET_TRANSPORT, 0));
  assert.deepEqual(setTransportPayload(Transport.WIFI), Uint8Array.of(ServerMessageType.SET_TRANSPORT, 1));
  // ESP-NOW: a channel byte rides along.
  assert.deepEqual(
    setTransportPayload(Transport.ESPNOW, ESPNOW_CHANNEL),
    Uint8Array.of(ServerMessageType.SET_TRANSPORT, 2, 1),
  );
  assert.deepEqual(getStatusPayload(), Uint8Array.of(ServerMessageType.GET_STATUS));
});

// ── Device → host: STATUS / LOG decode (USB only) ───────────────────────────────

test("decodeDeviceMessage reads STATUS with SSID, sign-extending RSSI", () => {
  const ssid = "GreenRoom-5G";
  const payload = Uint8Array.of(
    DeviceMessageType.STATUS, Transport.WIFI, WifiState.CONNECTED, 0xc4, // rssi -60
    ssid.length, ...new TextEncoder().encode(ssid),
  );
  assert.deepEqual(decodeDeviceMessage(payload), {
    kind: "status",
    transport: Transport.WIFI,
    wifiState: WifiState.CONNECTED,
    rssi: -60,
    ssid,
    channel: null, // no trailing bytes → pre-v3, channel unknown
    bridge: false, // …and bridge off
  });
});

test("decodeDeviceMessage reads STATUS with no creds (ssidLen 0 → empty SSID)", () => {
  const payload = Uint8Array.of(DeviceMessageType.STATUS, Transport.NOTX, WifiState.IDLE, 0, 0);
  assert.deepEqual(decodeDeviceMessage(payload), {
    kind: "status",
    transport: Transport.NOTX,
    wifiState: WifiState.IDLE,
    rssi: 0,
    ssid: "",
    channel: null,
    bridge: false,
  });
});

test("decodeDeviceMessage reads LOG text", () => {
  const payload = Uint8Array.of(DeviceMessageType.LOG, LogLevel.WARN, ...new TextEncoder().encode("hi"));
  assert.deepEqual(decodeDeviceMessage(payload), { kind: "log", level: LogLevel.WARN, text: "hi" });
});

test("decodeDeviceMessage rejects malformed STATUS/LOG", () => {
  assert.throws(() => decodeDeviceMessage(Uint8Array.of(DeviceMessageType.STATUS, 1, 1, 1)), RangeError); // < 5 bytes
  // ssidLen claims 3 bytes but only 1 follows → truncated tail
  assert.throws(() => decodeDeviceMessage(Uint8Array.of(DeviceMessageType.STATUS, 1, 1, 1, 3, 0x41)), RangeError);
  assert.throws(() => decodeDeviceMessage(Uint8Array.of(DeviceMessageType.LOG)), RangeError); // no level
});

// ── v1.3 ESP-NOW: STATUS [channel][bridging], RELAY, SET_BRIDGE, parseMac ──────────

test("decodeDeviceMessage reads the STATUS [channel][bridging] trailing bytes (v3)", () => {
  // [type][transport][wifiState][rssi][ssidLen=0][channel][bridging] — bridging on, channel 1.
  const on = Uint8Array.of(DeviceMessageType.STATUS, Transport.ESPNOW, WifiState.IDLE, 0, 0, 1, 0x01);
  assert.deepEqual(decodeDeviceMessage(on), {
    kind: "status",
    transport: Transport.ESPNOW,
    wifiState: WifiState.IDLE,
    rssi: 0,
    ssid: "",
    channel: 1,
    bridge: true,
  });
  // The trailing pair sits *after* the SSID, so it's read correctly even with creds present.
  const ssid = "venue";
  const withSsid = Uint8Array.of(
    DeviceMessageType.STATUS, Transport.WIFI, WifiState.CONNECTED, 0, ssid.length,
    ...new TextEncoder().encode(ssid), 6, 0x00, // channel 6, bridging off
  );
  assert.deepEqual(decodeDeviceMessage(withSsid), {
    kind: "status",
    transport: Transport.WIFI,
    wifiState: WifiState.CONNECTED,
    rssi: 0,
    ssid,
    channel: 6,
    bridge: false,
  });
});

test("decodeDeviceMessage treats a lone trailing byte as channel with bridging off (lenient)", () => {
  // Only one trailing byte present → read it as the channel, bridge defaults to false.
  const one = Uint8Array.of(DeviceMessageType.STATUS, Transport.ESPNOW, WifiState.IDLE, 0, 0, 11);
  assert.deepEqual(decodeDeviceMessage(one), {
    kind: "status",
    transport: Transport.ESPNOW,
    wifiState: WifiState.IDLE,
    rssi: 0,
    ssid: "",
    channel: 11,
    bridge: false,
  });
});

test("setBridgePayload encodes [type][enabled][channel]", () => {
  assert.deepEqual(setBridgePayload(true, ESPNOW_CHANNEL), Uint8Array.of(ServerMessageType.SET_BRIDGE, 1, 1));
  // Channel is still sent (and asserted) when disabling — the device ignores it then.
  assert.deepEqual(setBridgePayload(false, ESPNOW_CHANNEL), Uint8Array.of(ServerMessageType.SET_BRIDGE, 0, 1));
});

test("relayPayload wraps an inner payload in [type][targetMAC×6][inner…]", () => {
  const inner = setColorPayload(COLORS.live, 64);
  const wire = relayPayload("aa:bb:cc:dd:ee:ff", inner);
  assert.deepEqual(
    [...wire],
    [ServerMessageType.RELAY, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, ...inner],
  );
});

test("decodeDeviceMessage reads a RELAY envelope (srcMAC + inner)", () => {
  const inner = Uint8Array.of(DeviceMessageType.HEARTBEAT);
  const payload = Uint8Array.of(DeviceMessageType.RELAY, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, ...inner);
  const decoded = decodeDeviceMessage(payload);
  assert.equal(decoded.kind, "relayed");
  assert.deepEqual(decoded, { kind: "relayed", srcMac: "01:23:45:67:89:ab", inner: Uint8Array.of(DeviceMessageType.HEARTBEAT) });
});

test("decodeDeviceMessage rejects a RELAY envelope shorter than its 8-byte minimum", () => {
  // 7 bytes: type + 6 MAC bytes, but no inner type byte to relay.
  assert.throws(() => decodeDeviceMessage(Uint8Array.of(DeviceMessageType.RELAY, 1, 2, 3, 4, 5, 6)), RangeError);
});

test("parseMac round-trips with formatMac and rejects junk", () => {
  assert.deepEqual([...parseMac("01:23:45:67:89:AB")], [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]); // case-insensitive
  assert.equal(formatMac(parseMac("aa:bb:cc:dd:ee:ff")), "aa:bb:cc:dd:ee:ff");
  assert.throws(() => parseMac("aa:bb:cc:dd:ee"), RangeError); // too few octets
  assert.throws(() => parseMac("aa:bb:cc:dd:ee:gg"), RangeError); // non-hex
  assert.throws(() => parseMac("aabbccddeeff"), RangeError); // no separators
});

// ── Device → server decoder ────────────────────────────────────────────────────

function helloPayload(version: number, mac: number[]): Uint8Array {
  return Uint8Array.of(DeviceMessageType.HELLO, version, ...mac);
}

test("decodeDeviceMessage reads HELLO version and MAC", () => {
  const msg = decodeDeviceMessage(helloPayload(1, [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
  assert.deepEqual(msg, { kind: "hello", version: 1, mac: "aa:bb:cc:dd:ee:ff" });
});

test("decodeDeviceMessage reads HEARTBEAT", () => {
  assert.deepEqual(decodeDeviceMessage(Uint8Array.of(DeviceMessageType.HEARTBEAT)), {
    kind: "heartbeat",
  });
});

test("decodeDeviceMessage round-trips a framed HELLO via FrameDecoder", () => {
  const payload = helloPayload(1, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);
  const [decoded] = new FrameDecoder().push(frame(payload));
  assert.ok(decoded);
  assert.deepEqual(decodeDeviceMessage(decoded), {
    kind: "hello",
    version: 1,
    mac: "01:23:45:67:89:ab",
  });
});

test("decodeDeviceMessage rejects malformed payloads", () => {
  assert.throws(() => decodeDeviceMessage(new Uint8Array(0)), RangeError); // no type byte
  assert.throws(() => decodeDeviceMessage(helloPayload(1, [1, 2, 3])), RangeError); // short HELLO
  assert.throws(() => decodeDeviceMessage(Uint8Array.of(DeviceMessageType.HEARTBEAT, 0)), RangeError); // long HEARTBEAT
  assert.throws(() => decodeDeviceMessage(Uint8Array.of(0x7f)), RangeError); // unknown type
});

// ── MAC helpers ────────────────────────────────────────────────────────────────

test("formatMac renders six bytes as a lower-case colon MAC", () => {
  assert.equal(formatMac(Uint8Array.of(0, 0x1a, 0xb2, 0xc3, 0xd4, 0xe5)), "00:1a:b2:c3:d4:e5");
  assert.throws(() => formatMac(Uint8Array.of(1, 2, 3)), RangeError);
});

test("macTail keeps the last octets", () => {
  assert.equal(macTail("aa:bb:cc:dd:ee:ff"), "dd:ee:ff");
  assert.equal(macTail("aa:bb:cc:dd:ee:ff", 2), "ee:ff");
});

// ── Discovery ────────────────────────────────────────────────────────────────────

test("discovery request/response build and parse", () => {
  assert.ok(isDiscoveryRequest(DISCOVERY_REQUEST));
  assert.ok(!isDiscoveryRequest("nope"));

  assert.equal(encodeDiscoveryResponse(), "TALLY_HERE:7000");
  assert.equal(encodeDiscoveryResponse(7100), "TALLY_HERE:7100");

  assert.deepEqual(parseDiscoveryResponse("TALLY_HERE:7000"), { port: 7000 });
  assert.equal(parseDiscoveryResponse("TALLY_FIND"), null);
  assert.equal(parseDiscoveryResponse("TALLY_HERE:0"), null);
  assert.equal(parseDiscoveryResponse("TALLY_HERE:not-a-port"), null);
});

// ── Versioning ────────────────────────────────────────────────────────────────────

test("isSupportedVersion accepts the current version and rejects others", () => {
  assert.ok(isSupportedVersion(PROTOCOL_VERSION.CURRENT));
  assert.ok(isSupportedVersion(PROTOCOL_VERSION.MIN_SUPPORTED));
  assert.ok(!isSupportedVersion(PROTOCOL_VERSION.MIN_SUPPORTED - 1));
  assert.ok(!isSupportedVersion(PROTOCOL_VERSION.CURRENT + 1));
});

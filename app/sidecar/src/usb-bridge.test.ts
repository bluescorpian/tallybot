import { test } from "node:test";
import assert from "node:assert/strict";

import { DeviceMessageType, Transport, WifiState } from "./protocol.ts";
import { decodeUsbFrame, fromHex, parseUsbInbound, toHex } from "./usb-bridge.ts";

test("hex round-trips, rejecting malformed strings", () => {
  assert.equal(toHex(Uint8Array.of(0x01, 0xab, 0x00, 0xff)), "01ab00ff");
  assert.deepEqual([...fromHex("01ab00ff")], [0x01, 0xab, 0x00, 0xff]);
  assert.deepEqual([...fromHex("")], []);
  assert.throws(() => fromHex("abc"), RangeError); // odd length
  assert.throws(() => fromHex("zz"), RangeError); // not hex
});

test("parseUsbInbound recognises the shell→sidecar vocabulary", () => {
  assert.deepEqual(parseUsbInbound('{"type":"usbDeviceConnected","mac":"a","version":2}'), {
    type: "usbDeviceConnected",
    mac: "a",
    version: 2,
  });
  assert.deepEqual(parseUsbInbound('{"type":"unflashedDeviceDetected","port":"COM5"}'), {
    type: "unflashedDeviceDetected",
    port: "COM5",
  });
  // A UI command (not a USB bridge message) and junk both return null.
  assert.equal(parseUsbInbound('{"type":"assignDevice","mac":"a","inputId":1}'), null);
  assert.equal(parseUsbInbound("not json"), null);
});

test("decodeUsbFrame decodes an opaque STATUS payload via the shared codec", () => {
  const ssid = "venue";
  const payloadHex = toHex(
    Uint8Array.of(DeviceMessageType.STATUS, Transport.WIFI, WifiState.JOINING, 0, ssid.length, ...new TextEncoder().encode(ssid)),
  );
  assert.deepEqual(decodeUsbFrame({ type: "usbFrame", mac: "a", payloadHex }), {
    kind: "status",
    transport: Transport.WIFI,
    wifiState: WifiState.JOINING,
    rssi: 0,
    ssid,
  });
});

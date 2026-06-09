import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { COLORS, ServerMessageType, Transport, WifiState } from "./protocol.ts";
import { type UsbInbound, type UsbOutbound, fromHex, toHex } from "./usb-bridge.ts";
import { UsbTransport, transportModeValue } from "./usb-transport.ts";

/** A fake bridge: feed inbound `usb` messages in, capture the `usbSend`s out. */
class FakeBridge extends EventEmitter {
  readonly sent: UsbOutbound[] = [];
  sendUsb(message: UsbOutbound): void {
    this.sent.push(message);
  }
  feed(message: UsbInbound): void {
    this.emit("usb", message);
  }
}

const MAC = "aa:bb:cc:dd:ee:ff";

test("usbDeviceConnected → deviceConnected; disconnect → deviceDisconnected", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const connected: Array<{ mac: string; version: number }> = [];
  const disconnected: Array<{ mac: string }> = [];
  usb.on("deviceConnected", (i) => connected.push(i));
  usb.on("deviceDisconnected", (i) => disconnected.push(i));

  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 2 });
  assert.deepEqual(connected, [{ mac: MAC, version: 2 }]);
  assert.ok(usb.has(MAC));

  bridge.feed({ type: "usbDeviceDisconnected", mac: MAC });
  assert.deepEqual(disconnected, [{ mac: MAC }]);
  assert.ok(!usb.has(MAC));
});

test("an old firmware version raises deviceUnsupported", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const unsupported: Array<{ mac: string; version: number }> = [];
  usb.on("deviceUnsupported", (i) => unsupported.push(i));
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 0 }); // below MIN_SUPPORTED
  assert.deepEqual(unsupported, [{ mac: MAC, version: 0 }]);
});

test("sendColor emits a byte-identical SET_COLOR payload over the bridge", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  assert.equal(usb.sendColor(MAC, COLORS.live, 64), false); // not connected yet
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 2 });

  assert.equal(usb.sendColor(MAC, COLORS.live, 64), true);
  assert.equal(bridge.sent.length, 1);
  assert.equal(bridge.sent[0]!.mac, MAC);
  assert.deepEqual(
    [...fromHex(bridge.sent[0]!.payloadHex)],
    [ServerMessageType.SET_COLOR, 255, 0, 0, 64], // same body the TCP path frames
  );
});

test("provisionWifi / setTransport encode their payloads", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 2 });

  usb.provisionWifi(MAC, "Net", "pw");
  usb.setTransport(MAC, transportModeValue("notx"));
  assert.deepEqual([...fromHex(bridge.sent[0]!.payloadHex)], [
    ServerMessageType.SET_WIFI,
    3,
    0x4e,
    0x65,
    0x74,
    2,
    0x70,
    0x77,
  ]);
  assert.deepEqual([...fromHex(bridge.sent[1]!.payloadHex)], [ServerMessageType.SET_TRANSPORT, Transport.NOTX]);
});

test("an inbound STATUS frame is decoded into a status event", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const statuses: unknown[] = [];
  usb.on("status", (s) => statuses.push(s));
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 2 });

  // STATUS [type][transport][creds][wifiState][rssi=-50]
  const payload = Uint8Array.of(0x03, Transport.WIFI, 1, WifiState.CONNECTED, 0xce);
  bridge.feed({ type: "usbFrame", mac: MAC, payloadHex: toHex(payload) });
  assert.deepEqual(statuses, [
    { mac: MAC, mode: Transport.WIFI, credsPresent: true, wifiState: "connected", rssi: -50 },
  ]);
});

test("an inbound LOG frame becomes a log event", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const logs: unknown[] = [];
  usb.on("log", (l) => logs.push(l));
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 2 });

  const payload = Uint8Array.of(0x04, 2, ...new TextEncoder().encode("boom"));
  bridge.feed({ type: "usbFrame", mac: MAC, payloadHex: toHex(payload) });
  assert.deepEqual(logs, [{ mac: MAC, level: "error", text: "boom" }]);
});

test("unflashedDeviceDetected is surfaced", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const ports: string[] = [];
  usb.on("unflashed", ({ port }) => ports.push(port));
  bridge.feed({ type: "unflashedDeviceDetected", port: "/dev/ttyACM0" });
  assert.deepEqual(ports, ["/dev/ttyACM0"]);
});

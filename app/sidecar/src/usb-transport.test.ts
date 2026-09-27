import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { COLORS, DeviceMessageType, ServerMessageType, Transport, WifiState } from "./protocol.ts";
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

test("setTransport(espnow) appends the ESP-NOW channel byte", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 3 });

  usb.setTransport(MAC, transportModeValue("espnow"));
  // [type][mode=2][channel=1] — the channel rides only for ESP-NOW.
  assert.deepEqual([...fromHex(bridge.sent[0]!.payloadHex)], [ServerMessageType.SET_TRANSPORT, Transport.ESPNOW, 1]);
});

test("an inbound STATUS frame is decoded into a status event", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const statuses: unknown[] = [];
  usb.on("status", (s) => statuses.push(s));
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 2 });

  // STATUS [type][transport][wifiState][rssi=-50][ssidLen][ssid…]
  const ssid = "studio";
  const payload = Uint8Array.of(0x03, Transport.WIFI, WifiState.CONNECTED, 0xce, ssid.length, ...new TextEncoder().encode(ssid));
  bridge.feed({ type: "usbFrame", mac: MAC, payloadHex: toHex(payload) });
  assert.deepEqual(statuses, [
    { mac: MAC, mode: Transport.WIFI, wifiState: "connected", rssi: -50, ssid, channel: null, bridge: false },
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

// ── v1.3 ESP-NOW ─────────────────────────────────────────────────────────────────

test("transportModeValue maps espnow to the ESPNOW wire byte", () => {
  assert.equal(transportModeValue("notx"), Transport.NOTX);
  assert.equal(transportModeValue("wifi"), Transport.WIFI);
  assert.equal(transportModeValue("espnow"), Transport.ESPNOW);
});

test("a STATUS with the [channel][bridging] pair surfaces channel + bridge", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const statuses: Array<{ channel: number | null; bridge: boolean }> = [];
  usb.on("status", (s) => statuses.push(s));
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 3 });

  // STATUS [type][transport=ESPNOW][wifiState=idle][rssi=0][ssidLen=0][channel=1][bridging=1]
  const payload = Uint8Array.of(DeviceMessageType.STATUS, Transport.ESPNOW, WifiState.IDLE, 0, 0, 1, 0x01);
  bridge.feed({ type: "usbFrame", mac: MAC, payloadHex: toHex(payload) });
  assert.equal(statuses.at(-1)?.channel, 1);
  assert.equal(statuses.at(-1)?.bridge, true);
});

test("setBridge sends [type][enabled][channel] only while the device is on USB", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  assert.equal(usb.setBridge(MAC, true), false); // not connected yet
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 3 });

  assert.equal(usb.setBridge(MAC, true), true);
  // 3 bytes ending in the ESP-NOW channel (1).
  assert.deepEqual([...fromHex(bridge.sent[0]!.payloadHex)], [ServerMessageType.SET_BRIDGE, 1, 1]);
  usb.setBridge(MAC, false);
  assert.deepEqual([...fromHex(bridge.sent[1]!.payloadHex)], [ServerMessageType.SET_BRIDGE, 0, 1]);
});

test("a RELAY frame is re-emitted as a relayed event (bridgeMac + srcMac + inner)", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const relayed: Array<{ bridgeMac: string; srcMac: string; inner: Uint8Array }> = [];
  usb.on("relayed", (r) => relayed.push(r));
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 3 });

  // The bridge (MAC) forwards a light's HELLO up: RELAY [srcMAC×6][inner HELLO].
  const light = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab];
  const inner = [DeviceMessageType.HELLO, 3, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x11];
  const payload = Uint8Array.of(DeviceMessageType.RELAY, ...light, ...inner);
  bridge.feed({ type: "usbFrame", mac: MAC, payloadHex: toHex(payload) });

  assert.equal(relayed.length, 1);
  assert.equal(relayed[0]!.bridgeMac, MAC); // the USB device the frame arrived on
  assert.equal(relayed[0]!.srcMac, "01:23:45:67:89:ab"); // the light, from the bridge's RX callback
  assert.deepEqual([...relayed[0]!.inner], inner);
});

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
  assert.equal(usb.sendColor(MAC, COLORS.idle, 128), true);

  bridge.feed({ type: "usbDeviceDisconnected", mac: MAC });
  assert.deepEqual(disconnected, [{ mac: MAC }]);
  assert.equal(usb.sendColor(MAC, COLORS.idle, 128), false);
});

test("an old firmware version raises deviceUnsupported", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const unsupported: Array<{ mac: string; version: number; reason: string }> = [];
  usb.on("deviceUnsupported", (i) => unsupported.push(i));
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 0 }); // below MIN_SUPPORTED
  assert.deepEqual(unsupported, [{ mac: MAC, version: 0, reason: "device-too-old" }]);
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
  usb.setTransport(MAC, transportModeValue("notx"), null);
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

  usb.setTransport(MAC, transportModeValue("espnow"), 6);
  // [type][mode=2][channel=6] — the channel rides only for ESP-NOW.
  assert.deepEqual([...fromHex(bridge.sent[0]!.payloadHex)], [ServerMessageType.SET_TRANSPORT, Transport.ESPNOW, 6]);
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

test("an inbound FIRMWARE frame becomes a firmware event for that device", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const reported: unknown[] = [];
  usb.on("firmware", (f) => reported.push(f));
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 3 });

  const payload = Uint8Array.of(0x07, ...new TextEncoder().encode("1.1.0"));
  bridge.feed({ type: "usbFrame", mac: MAC, payloadHex: toHex(payload) });
  assert.deepEqual(reported, [{ mac: MAC, version: "1.1.0" }]);
});

test("a FIRMWARE frame from a device not currently connected is ignored", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const reported: unknown[] = [];
  usb.on("firmware", (f) => reported.push(f));
  const firmwareFrame = { type: "usbFrame", mac: MAC, payloadHex: toHex(Uint8Array.of(0x07, ...new TextEncoder().encode("1.1.0"))) } as const;

  bridge.feed(firmwareFrame); // before its HELLO
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 3 });
  bridge.feed({ type: "usbDeviceDisconnected", mac: MAC });
  bridge.feed(firmwareFrame); // a frame that outlived its disconnect
  assert.deepEqual(reported, []);
});

// ── v1.3 ESP-NOW ─────────────────────────────────────────────────────────────────

test("transportModeValue maps espnow to the ESPNOW wire byte", () => {
  assert.equal(transportModeValue("notx"), Transport.NOTX);
  assert.equal(transportModeValue("wifi"), Transport.WIFI);
  assert.equal(transportModeValue("espnow"), Transport.ESPNOW);
});

test("a STATUS wifiState byte this sidecar doesn't know reads as unknown (null), not idle", () => {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge);
  const statuses: Array<{ wifiState: unknown }> = [];
  usb.on("status", (s) => statuses.push(s));
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 3 });

  // STATUS [type][transport=WIFI][wifiState=0x7f, from newer firmware][rssi=0][ssidLen=0]
  const payload = Uint8Array.of(DeviceMessageType.STATUS, Transport.WIFI, 0x7f, 0, 0);
  bridge.feed({ type: "usbFrame", mac: MAC, payloadHex: toHex(payload) });
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.wifiState, null);
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
  assert.equal(usb.setBridge(MAC, true, 6), false); // not connected yet
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 3 });

  assert.equal(usb.setBridge(MAC, true, 6), true);
  // 3 bytes ending in the ESP-NOW channel (6).
  assert.deepEqual([...fromHex(bridge.sent[0]!.payloadHex)], [ServerMessageType.SET_BRIDGE, 1, 6]);
  usb.setBridge(MAC, false, 6);
  assert.deepEqual([...fromHex(bridge.sent[1]!.payloadHex)], [ServerMessageType.SET_BRIDGE, 0, 6]);
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

// ── v1.4 channel scan (SCAN_WIFI → SCAN_RESULT) ─────────────────────────────────

/** A SCAN_RESULT frame from MAC: `[type][index][total][channel][rssi][ssidLen][ssid…]`. */
function scanResult(index: number, total: number, channel: number, rssi: number, ssid: string): UsbInbound {
  const bytes = new TextEncoder().encode(ssid);
  const payload = Uint8Array.of(DeviceMessageType.SCAN_RESULT, index, total, channel, rssi & 0xff, bytes.length, ...bytes);
  return { type: "usbFrame", mac: MAC, payloadHex: toHex(payload) };
}

/** Whether a scan promise has settled by the next turn of the event loop (well before any timeout). */
function settled(scan: Promise<unknown>): Promise<"resolved" | "rejected" | "pending"> {
  return Promise.race([
    scan.then(() => "resolved" as const, () => "rejected" as const),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

function scanningTransport(scanTimeoutMs = 1_000): { bridge: FakeBridge; usb: UsbTransport } {
  const bridge = new FakeBridge();
  const usb = new UsbTransport(bridge, { scanTimeoutMs });
  bridge.feed({ type: "usbDeviceConnected", mac: MAC, version: 4 });
  return { bridge, usb };
}

test("scanWifi sends SCAN_WIFI and resolves with every access point once frames 0..total-1 arrive", async () => {
  const { bridge, usb } = scanningTransport();
  const scan = usb.scanWifi(MAC);
  assert.ok(scan);
  assert.deepEqual([...fromHex(bridge.sent[0]!.payloadHex)], [ServerMessageType.SCAN_WIFI]);

  bridge.feed(scanResult(0, 2, 6, -40, "studio"));
  bridge.feed(scanResult(1, 2, 11, -80, "venue"));
  assert.deepEqual(await scan, [
    { channel: 6, rssi: -40, ssid: "studio" },
    { channel: 11, rssi: -80, ssid: "venue" },
  ]);
});

test("one empty SCAN_RESULT frame is a scan that heard nothing, not a failure", async () => {
  const { bridge, usb } = scanningTransport();
  const scan = usb.scanWifi(MAC);
  bridge.feed({ type: "usbFrame", mac: MAC, payloadHex: toHex(Uint8Array.of(DeviceMessageType.SCAN_RESULT, 0, 0, 0, 0, 0)) });
  assert.deepEqual(await scan, []);
});

test("a scan the device never answers rejects at the timeout rather than reading as a quiet band", async () => {
  const { usb } = scanningTransport(20);
  await assert.rejects(usb.scanWifi(MAC)!);
});

test("a scan that stops part-way through its frames rejects at the timeout", async () => {
  const { bridge, usb } = scanningTransport(20);
  const scan = usb.scanWifi(MAC);
  bridge.feed(scanResult(0, 3, 1, -50, "a"));
  bridge.feed(scanResult(1, 3, 6, -50, "b"));
  await assert.rejects(scan!);
});

test("frames out of order fail the scan instead of yielding a partial list", async () => {
  const { bridge, usb } = scanningTransport();
  const scan = usb.scanWifi(MAC);
  bridge.feed(scanResult(0, 3, 1, -50, "a"));
  bridge.feed(scanResult(2, 3, 11, -50, "c")); // index 1 skipped
  assert.equal(await settled(scan!), "rejected");
});

test("a device unplugged mid-scan fails the scan", async () => {
  const { bridge, usb } = scanningTransport();
  const scan = usb.scanWifi(MAC);
  bridge.feed(scanResult(0, 2, 1, -50, "a"));
  bridge.feed({ type: "usbDeviceDisconnected", mac: MAC });
  assert.equal(await settled(scan!), "rejected");
});

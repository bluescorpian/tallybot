import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type { DeviceServerPort } from "./app.ts";
import { CompositeDeviceServer } from "./composite-device-server.ts";
import { COLORS, type Color } from "./protocol.ts";

/** A fake transport: drive connect/disconnect, record routed sends. */
class FakeTransport extends EventEmitter implements DeviceServerPort {
  readonly colors: Array<{ mac: string; color: Color; brightness: number }> = [];
  started = false;
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {}
  sendColor(mac: string, color: Color, brightness: number): boolean {
    this.colors.push({ mac, color, brightness });
    return true;
  }
  identify(): boolean {
    return true;
  }
  connect(mac: string, version = 2): void {
    this.emit("deviceConnected", { mac, version });
  }
  disconnect(mac: string): void {
    this.emit("deviceDisconnected", { mac });
  }
}

const MAC = "aa:bb:cc:dd:ee:ff";

function setup() {
  const usb = new FakeTransport();
  const tcp = new FakeTransport();
  // USB listed first ⇒ higher priority ("USB wins").
  const composite = new CompositeDeviceServer([
    { transport: "usb", port: usb },
    { transport: "wifi", port: tcp },
  ]);
  const connected: Array<{ mac: string; version: number }> = [];
  const disconnected: Array<{ mac: string }> = [];
  composite.on("deviceConnected", (i) => connected.push(i));
  composite.on("deviceDisconnected", (i) => disconnected.push(i));
  return { usb, tcp, composite, connected, disconnected };
}

test("start() starts every member transport", async () => {
  const { usb, tcp, composite } = setup();
  await composite.start();
  assert.ok(usb.started && tcp.started);
});

test("a WiFi-only device is tagged wifi and routed over TCP", () => {
  const { tcp, composite, connected } = setup();
  tcp.connect(MAC);
  assert.deepEqual(connected, [{ mac: MAC, version: 2 }]);
  assert.equal(composite.transportOf(MAC), "wifi");
  composite.sendColor(MAC, COLORS.live, 128);
  assert.equal(tcp.colors.length, 1);
});

test("USB wins: same MAC on both appears once (USB), routed over USB", () => {
  const { usb, tcp, composite, connected } = setup();
  tcp.connect(MAC, 1);
  usb.connect(MAC, 2); // USB takes over
  // Two announcements (initial WiFi, then the USB takeover) but never a duplicate "device".
  assert.deepEqual(connected, [
    { mac: MAC, version: 1 },
    { mac: MAC, version: 2 },
  ]);
  assert.equal(composite.transportOf(MAC), "usb");

  composite.sendColor(MAC, COLORS.live, 128);
  assert.equal(usb.colors.length, 1, "routed to USB");
  assert.equal(tcp.colors.length, 0, "not to TCP");
});

test("a lower-priority duplicate under an existing owner is suppressed", () => {
  const { usb, tcp, composite, connected } = setup();
  usb.connect(MAC, 2);
  tcp.connect(MAC, 2); // arrives second, lower priority — no new announcement
  assert.deepEqual(connected, [{ mac: MAC, version: 2 }]);
  assert.equal(composite.transportOf(MAC), "usb");
});

test("unplugging USB reverts a still-WiFi device rather than dropping it", () => {
  const { usb, tcp, composite, connected, disconnected } = setup();
  tcp.connect(MAC, 1);
  usb.connect(MAC, 2);
  usb.disconnect(MAC); // cable pulled; WiFi still there

  assert.deepEqual(disconnected, [], "not disconnected — it reverts");
  assert.equal(connected.at(-1)?.version, 1, "re-announced for the WiFi owner");
  assert.equal(composite.transportOf(MAC), "wifi");
  composite.sendColor(MAC, COLORS.idle, 128);
  assert.equal(tcp.colors.length, 1, "routes over TCP again");
});

test("the last transport dropping emits deviceDisconnected", () => {
  const { tcp, composite, disconnected } = setup();
  tcp.connect(MAC);
  tcp.disconnect(MAC);
  assert.deepEqual(disconnected, [{ mac: MAC }]);
  assert.equal(composite.transportOf(MAC), null);
  assert.equal(composite.sendColor(MAC, COLORS.live, 128), false);
});

test("deviceUnsupported is forwarded from any member", () => {
  const { tcp, composite } = setup();
  const unsupported: unknown[] = [];
  composite.on("deviceUnsupported", (i) => unsupported.push(i));
  tcp.emit("deviceUnsupported", { mac: MAC, version: 0 });
  assert.deepEqual(unsupported, [{ mac: MAC, version: 0 }]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  type AtemSourcePort,
  type AnimationClock,
  type DeviceServerPort,
  type EspNowBridgePort,
  type IpcPort,
  type ProvisioningPort,
  type SidecarAppDeps,
  type StorePort,
  SidecarApp,
} from "./app.ts";
import type { SourceSnapshot } from "./engine.ts";
import type { DeviceConfig } from "./store.ts";
import type { DeviceTransport, DeviceWifiState, SidecarEvent, StateEvent } from "./ipc.ts";
import { type Color, COLORS, DEFAULT_BRIGHTNESS, SETUP_COLOR, Transport } from "./protocol.ts";

// ── In-memory fakes for the orchestrator's ports ─────────────────────────────────

class FakeDeviceServer extends EventEmitter implements DeviceServerPort {
  readonly sent: Array<{ mac: string; color: Color; brightness: number }> = [];
  readonly #connected = new Set<string>();

  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  sendColor(mac: string, color: Color, brightness: number): boolean {
    if (!this.#connected.has(mac)) return false;
    this.sent.push({ mac, color, brightness });
    return true;
  }
  // Test drivers:
  connectDevice(mac: string, version = 1): void {
    this.#connected.add(mac);
    this.emit("deviceConnected", { mac, version });
  }
  disconnectDevice(mac: string): void {
    this.#connected.delete(mac);
    this.emit("deviceDisconnected", { mac });
  }
  sentTo(mac: string): Array<{ color: Color; brightness: number }> {
    return this.sent.filter((s) => s.mac === mac);
  }
}

class FakeAtemSource extends EventEmitter implements AtemSourcePort {
  readonly connects: string[] = [];
  #snap: SourceSnapshot;
  constructor(snap: SourceSnapshot) {
    super();
    this.#snap = snap;
  }
  snapshot(): SourceSnapshot {
    return this.#snap;
  }
  connect(ip: string): void {
    this.connects.push(ip);
    this.set({ ...this.#snap, ip, connection: "connected" });
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  set(snap: SourceSnapshot): void {
    this.#snap = snap;
    this.emit("change", snap);
  }
}

class FakeIpc extends EventEmitter implements IpcPort {
  readonly events: SidecarEvent[] = [];
  readonly notices: Array<{ level: string; message: string }> = [];
  send(event: SidecarEvent): void {
    this.events.push(event);
  }
  notice(level: "info" | "warn" | "error", message: string): void {
    this.notices.push({ level, message });
  }
  close(): void {}
  command(cmd: Parameters<Parameters<IpcPort["on"]>[1]>[0]): void {
    this.emit("command", cmd);
  }
  lastState(): StateEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i]!;
      if (event.type === "state") return event;
    }
    return undefined;
  }
}

class FakeStore implements StorePort {
  sourceIp: string | null = null;
  bridgeMac: string | null = null;
  readonly #devices = new Map<string, DeviceConfig>();
  device(mac: string): DeviceConfig | undefined {
    return this.#devices.get(mac);
  }
  devices(): Array<[string, DeviceConfig]> {
    return [...this.#devices.entries()];
  }
  setSourceIp(ip: string | null): Promise<void> {
    this.sourceIp = ip;
    return Promise.resolve();
  }
  setBridgeMac(mac: string | null): Promise<void> {
    this.bridgeMac = mac;
    return Promise.resolve();
  }
  assign(mac: string, inputId: number): Promise<void> {
    this.#ensure(mac).inputId = inputId;
    return Promise.resolve();
  }
  unassign(mac: string): Promise<void> {
    const device = this.#devices.get(mac);
    if (device) device.inputId = null;
    return Promise.resolve();
  }
  setBrightness(mac: string, brightness: number): Promise<void> {
    this.#ensure(mac).brightness = brightness;
    return Promise.resolve();
  }
  setSsid(mac: string, ssid: string | null): Promise<void> {
    const device = this.#ensure(mac);
    if (ssid === null) delete device.ssid;
    else device.ssid = ssid;
    return Promise.resolve();
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  #ensure(mac: string): DeviceConfig {
    let device = this.#devices.get(mac);
    if (!device) {
      device = { inputId: null, brightness: DEFAULT_BRIGHTNESS };
      this.#devices.set(mac, device);
    }
    return device;
  }
}

/**
 * The USB provisioning surface. Records outbound calls and lets a test push STATUS frames the
 * way a cabled device would. `transportOf` reports "usb" only for MACs the test marks wired, so
 * tests that never touch USB see the same `transport: "wifi"` default as before.
 */
class FakeProvisioning extends EventEmitter implements ProvisioningPort {
  readonly provisioned: Array<{ mac: string; ssid: string; password: string }> = [];
  readonly transports: Array<{ mac: string; mode: number }> = [];
  readonly bridges: Array<{ mac: string; enabled: boolean }> = [];
  readonly statusRequested: string[] = [];
  /** MACs currently reachable over USB (drives `transportOf` + the boolean returns). */
  readonly wired = new Set<string>();

  transportOf(mac: string): DeviceTransport | null {
    return this.wired.has(mac) ? "usb" : null;
  }
  provisionWifi(mac: string, ssid: string, password: string): boolean {
    if (!this.wired.has(mac)) return false;
    this.provisioned.push({ mac, ssid, password });
    return true;
  }
  setTransport(mac: string, mode: number): boolean {
    if (!this.wired.has(mac)) return false;
    this.transports.push({ mac, mode });
    return true;
  }
  setBridge(mac: string, enabled: boolean): boolean {
    if (!this.wired.has(mac)) return false;
    this.bridges.push({ mac, enabled });
    return true;
  }
  requestStatus(mac: string): boolean {
    this.statusRequested.push(mac);
    return this.wired.has(mac);
  }
  // Test driver: stream a STATUS frame as the device would over the cable.
  emitStatus(
    mac: string,
    fields: {
      mode: number;
      wifiState: DeviceWifiState;
      rssi: number | null;
      ssid: string;
      channel?: number | null;
      bridge?: boolean;
    },
  ): void {
    this.emit("status", { mac, channel: null, bridge: false, ...fields });
  }
}

/** Records the bridge MAC the orchestrator routes ESP-NOW colours through. */
class FakeEspNow implements EspNowBridgePort {
  readonly bridgeMacs: Array<string | null> = [];
  setBridgeMac(mac: string | null): void {
    this.bridgeMacs.push(mac);
  }
}

/** An animation clock the test steps by hand, so motion is deterministic (no wall clock). */
class FakeAnimClock implements AnimationClock {
  #tick: (() => void) | null = null;
  start(_intervalMs: number, tick: () => void): () => void {
    this.#tick = tick;
    return () => {
      this.#tick = null;
    };
  }
  /** True while an animation is armed. */
  get running(): boolean {
    return this.#tick !== null;
  }
  /** Advance one tick (the harness sets the tick to 500 ms, i.e. one flash half-cycle). */
  step(): void {
    this.#tick?.();
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

const MAC = "aa:bb:cc:dd:ee:01";
/** Mirrors app.ts: one fault-flash half-cycle. The harness ticks the clock at this rate. */
const FLASH_HALF_MS = 500;

function connectedSource(): SourceSnapshot {
  return {
    ip: "10.0.0.5",
    connection: "connected",
    programInput: 1,
    previewInput: 2,
    inputs: [
      { id: 1, label: "Camera 1" },
      { id: 2, label: "Camera 2" },
      { id: 3, label: "Camera 3" },
    ],
  };
}

interface Harness {
  app: SidecarApp;
  server: FakeDeviceServer;
  atem: FakeAtemSource;
  ipc: FakeIpc;
  store: FakeStore;
  provisioning: FakeProvisioning;
  espnow: FakeEspNow;
  anim: FakeAnimClock;
  refresh: FakeAnimClock;
}

function setup(
  source: SourceSnapshot = connectedSource(),
  overrides: Partial<Pick<SidecarAppDeps, "scanNetwork">> = {},
): Harness {
  const server = new FakeDeviceServer();
  const atem = new FakeAtemSource(source);
  const ipc = new FakeIpc();
  const store = new FakeStore();
  const provisioning = new FakeProvisioning();
  const espnow = new FakeEspNow();
  const anim = new FakeAnimClock();
  const refresh = new FakeAnimClock();
  const app = new SidecarApp({
    atem,
    deviceServer: server,
    provisioning,
    espnow,
    store,
    ipc,
    animClock: anim,
    animTickMs: FLASH_HALF_MS, // one step == one flash half-cycle, so flash tests read as toggles
    refreshClock: refresh, // steppable so the keyframe re-send is deterministic (no real 1 s timer)
    log: () => {},
    ...overrides,
  });
  return { app, server, atem, ipc, store, provisioning, espnow, anim, refresh };
}

/** Let an async command handler (which awaits the store) settle. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── Tests ──────────────────────────────────────────────────────────────────────

test("start emits an initial snapshot", async () => {
  const { app, ipc } = setup();
  await app.start();
  assert.ok(ipc.lastState(), "a state event is emitted on start");
});

test("a connecting device is immediately shown the setup colour", async () => {
  const { app, server, ipc } = setup();
  await app.start();

  server.connectDevice(MAC);
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, SETUP_COLOR);
  assert.equal(ipc.lastState()!.state.devices[0]!.state, "unassigned");
});

test("assigning a device sends its input's tally colour and persists the binding", async () => {
  const { app, server, store, ipc } = setup();
  await app.start();
  server.connectDevice(MAC);

  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 }); // input 1 is on program → live
  await tick();

  assert.equal(store.device(MAC)?.inputId, 1);
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.live);
  assert.equal(ipc.lastState()!.state.devices[0]!.state, "assigned");
});

test("a state change that doesn't affect a device's colour is not re-sent", async () => {
  const { app, server, atem, ipc } = setup();
  await app.start();
  server.connectDevice(MAC);
  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 });
  await tick();
  const before = server.sentTo(MAC).length;

  // Preview moves to input 3; input 1 is still on program, so MAC stays live.
  atem.set({ ...connectedSource(), previewInput: 3 });

  assert.equal(server.sentTo(MAC).length, before, "no redundant SET_COLOR for an unchanged colour");
});

test("the refresh tick re-asserts a steady device's colour (keyframe for lossy transports)", async () => {
  const { app, server, ipc, refresh } = setup();
  await app.start();
  server.connectDevice(MAC);
  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 }); // live
  await tick();
  const before = server.sentTo(MAC).length;

  // No state change — a normal #sync would stay quiet (see the test above), but the periodic
  // keyframe re-sends the current colour unconditionally so a dropped packet self-heals.
  refresh.step();

  assert.equal(server.sentTo(MAC).length, before + 1, "keyframe re-sends despite no change");
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.live, "and it's the current colour");
});

test("the refresh tick does nothing when no device is connected", async () => {
  const { app, server, refresh } = setup();
  await app.start();

  refresh.step();

  assert.equal(server.sent.length, 0, "no devices online → no keyframe traffic");
});

test("changing brightness re-sends the same colour at the new level", async () => {
  const { app, server, ipc } = setup();
  await app.start();
  server.connectDevice(MAC);
  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 });
  await tick();

  ipc.command({ type: "setBrightness", mac: MAC, brightness: 50 });
  await tick();

  const last = server.sentTo(MAC).at(-1)!;
  assert.deepEqual(last.color, COLORS.live);
  assert.equal(last.brightness, 50);
});

test("a reconnecting device is re-sent its colour even if tally is unchanged", async () => {
  const { app, server, ipc } = setup();
  await app.start();
  server.connectDevice(MAC);
  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 });
  await tick();

  server.disconnectDevice(MAC);
  const before = server.sentTo(MAC).length;
  server.connectDevice(MAC); // reconnect: lastColor was cleared, so it must be re-sent

  assert.equal(server.sentTo(MAC).length, before + 1);
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.live);
});

test("a disconnected device reads as offline and gets no colour", async () => {
  const { app, server, ipc } = setup();
  await app.start();
  server.connectDevice(MAC);
  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 });
  await tick();

  server.disconnectDevice(MAC);
  const device = ipc.lastState()!.state.devices.find((d) => d.mac === MAC)!;
  assert.equal(device.state, "offline");
  assert.equal(device.inputId, 1, "the assignment is remembered while offline");
});

test("when the source drops, an assigned device flashes blue instead of resting on idle", async () => {
  const { app, server, atem, ipc, anim } = setup(); // connected, program 1
  await app.start();
  server.connectDevice(MAC);
  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 });
  await tick();
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.live, "healthy source → live red");
  assert.equal(anim.running, false, "no fault, no animation");

  // The ATEM drops (inputs retained, but the connection is gone).
  atem.set({ ...connectedSource(), connection: "disconnected" });
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.disconnected, "fault is blue, not idle green");
  assert.notDeepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.idle);
  assert.equal(anim.running, true, "the flash is armed");

  // Stepping the clock (one half-cycle) pulses the LED off, then back to blue — i.e. it flashes.
  anim.step();
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, { r: 0, g: 0, b: 0 }, "dark phase");
  anim.step();
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.disconnected, "lit phase again");

  // Source recovers → back to a steady live red and the animation stops.
  atem.set(connectedSource());
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.live);
  assert.equal(anim.running, false, "recovery disarms the animation");
});

test("an unassigned device breathes the setup colour (server-driven brightness envelope)", async () => {
  const { app, server, anim } = setup();
  await app.start();
  server.connectDevice(MAC); // connected but unassigned

  // The colour is the white setup colour, and the breathe is armed.
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, SETUP_COLOR, "unassigned shows the setup colour");
  assert.equal(anim.running, true, "the breathe is armed");

  // It starts at the trough (dim, not full) and swells as the clock advances — colour unchanged.
  const lastBrightness = () => server.sentTo(MAC).at(-1)!.brightness;
  const b0 = lastBrightness(); // elapsed 0 → trough
  assert.ok(b0 < DEFAULT_BRIGHTNESS, "breathing, not resting at full brightness");
  anim.step();
  const b1 = lastBrightness();
  anim.step();
  const b2 = lastBrightness();
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, SETUP_COLOR, "still white while breathing");
  assert.ok(b1 > b0 && b2 > b1, "brightness swells across the breathe");
});

test("identify drives a server-streamed locate strobe, and warns when offline", async () => {
  const { app, server, ipc, anim } = setup();
  await app.start();

  ipc.command({ type: "identifyDevice", mac: MAC }); // not connected yet
  await tick();
  assert.equal(server.sentTo(MAC).length, 0, "nothing is streamed to an offline device");
  assert.equal(ipc.notices.at(-1)?.level, "info");

  server.connectDevice(MAC);
  ipc.command({ type: "assignDevice", mac: MAC, inputId: 3 }); // input 3 is idle (program 1, preview 2)
  await tick();
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.idle, "resting on idle before the flash");

  ipc.command({ type: "identifyDevice", mac: MAC });
  await tick();
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, { r: 255, g: 255, b: 255 }, "strobe starts lit (white)");
  assert.ok(anim.running, "the strobe arms the animation clock");

  anim.step(); // into the strobe's dark phase
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, { r: 0, g: 0, b: 0 }, "strobe's dark phase");

  anim.step(); // past the burst → the device's real colour resumes and the clock disarms
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.idle, "idle resumes once the strobe ends");
  assert.ok(!anim.running, "the clock stops when the strobe is the last animation");
});

test("setSource persists the IP and connects the ATEM", async () => {
  const { app, atem, store, ipc } = setup({
    ip: null,
    connection: "disconnected",
    programInput: null,
    previewInput: null,
    inputs: [],
  });
  await app.start();

  ipc.command({ type: "setSource", ip: "10.0.0.9" });
  await tick();

  assert.equal(store.sourceIp, "10.0.0.9");
  assert.deepEqual(atem.connects, ["10.0.0.9"]);
});

test("an unsupported-firmware device raises a warning notice", async () => {
  const { app, server, ipc } = setup();
  await app.start();

  server.emit("deviceUnsupported", { mac: MAC, version: 0 });
  assert.equal(ipc.notices.at(-1)?.level, "warn");
  assert.match(ipc.notices.at(-1)!.message, /firmware/i);
});

test("on startup with a saved IP, the ATEM is connected automatically", async () => {
  const { app, atem, store } = setup({
    ip: null,
    connection: "disconnected",
    programInput: null,
    previewInput: null,
    inputs: [],
  });
  store.sourceIp = "10.0.0.7";
  await app.start();
  assert.deepEqual(atem.connects, ["10.0.0.7"]);
});

test("scanSources emits a scanning event then a done event with the hits", async () => {
  const hits = [{ ip: "10.0.0.5", product: "ATEM Mini Pro" }];
  const { app, ipc } = setup(connectedSource(), { scanNetwork: () => Promise.resolve(hits) });
  await app.start();

  ipc.command({ type: "scanSources" });
  await tick();

  const scans = ipc.events.filter((e) => e.type === "sourceScan");
  assert.deepEqual(
    scans.map((e) => e.status),
    ["scanning", "done"],
  );
  assert.deepEqual(scans.at(-1), { type: "sourceScan", status: "done", found: hits, error: null });
});

test("scanSources reports a sweep failure as an error result", async () => {
  const { app, ipc } = setup(connectedSource(), {
    scanNetwork: () => Promise.reject(new Error("no interface")),
  });
  await app.start();

  ipc.command({ type: "scanSources" });
  await tick();

  const done = ipc.events.filter((e) => e.type === "sourceScan").at(-1);
  assert.equal(done?.status, "done");
  assert.equal(done?.error, "no interface");
  assert.deepEqual(done?.found, []);
});

// ── v1.2 USB provisioning ────────────────────────────────────────────────────

test("provisionWifi sends the creds, persists the SSID, and surfaces it in the snapshot", async () => {
  const { app, server, ipc, provisioning, store } = setup();
  await app.start();
  provisioning.wired.add(MAC);
  server.connectDevice(MAC, 2);

  ipc.command({ type: "provisionWifi", mac: MAC, ssid: "GreenRoom-5G", password: "hunter2" });
  await tick();

  assert.deepEqual(provisioning.provisioned, [{ mac: MAC, ssid: "GreenRoom-5G", password: "hunter2" }]);
  assert.equal(store.device(MAC)?.ssid, "GreenRoom-5G"); // remembered host-side
  assert.equal(ipc.lastState()!.state.devices.find((d) => d.mac === MAC)!.ssid, "GreenRoom-5G");
});

test("provisionWifi on a device that isn't on USB warns and persists nothing", async () => {
  const { app, ipc, provisioning, store } = setup();
  await app.start();
  // MAC is not in provisioning.wired → provisionWifi returns false.

  ipc.command({ type: "provisionWifi", mac: MAC, ssid: "Net", password: "pw" });
  await tick();

  assert.deepEqual(provisioning.provisioned, []);
  assert.equal(store.device(MAC)?.ssid, undefined);
  assert.ok(ipc.notices.some((n) => /can't provision WiFi/.test(n.message)));
});

test("a USB STATUS frame surfaces provisionedMode / wifiState / rssi and adopts the device's SSID", async () => {
  const { app, server, ipc, provisioning, store } = setup();
  await app.start();
  provisioning.wired.add(MAC);
  server.connectDevice(MAC, 2);

  provisioning.emitStatus(MAC, {
    mode: Transport.WIFI,
    wifiState: "connected" as DeviceWifiState,
    rssi: -58,
    ssid: "BackdropAP",
  });
  await tick();

  const device = ipc.lastState()!.state.devices.find((d) => d.mac === MAC)!;
  assert.equal(device.transport, "usb"); // wired → indicator
  assert.equal(device.provisionedMode, "wifi");
  assert.equal(device.wifiState, "connected");
  assert.equal(device.rssi, -58);
  assert.equal(device.ssid, "BackdropAP"); // adopted from the device's NVS-reported SSID
  assert.equal(store.device(MAC)?.ssid, "BackdropAP"); // …and persisted host-side
});

test("a STATUS with an empty SSID clears a stale stored SSID (device has no creds)", async () => {
  const { app, server, ipc, provisioning, store } = setup();
  await app.start();
  provisioning.wired.add(MAC);
  server.connectDevice(MAC, 2);
  // Seed a host-side SSID, then have the device report it has no creds.
  ipc.command({ type: "provisionWifi", mac: MAC, ssid: "OldNet", password: "pw" });
  await tick();
  assert.equal(store.device(MAC)?.ssid, "OldNet");

  provisioning.emitStatus(MAC, { mode: Transport.NOTX, wifiState: "idle" as DeviceWifiState, rssi: null, ssid: "" });
  await tick();

  assert.equal(store.device(MAC)?.ssid, undefined); // cleared to match device truth
  assert.equal(ipc.lastState()!.state.devices.find((d) => d.mac === MAC)!.ssid, null);
});

test("setTransport(notx) sets the mode and clears any remembered SSID", async () => {
  const { app, server, ipc, provisioning, store } = setup();
  await app.start();
  provisioning.wired.add(MAC);
  server.connectDevice(MAC, 2);
  ipc.command({ type: "provisionWifi", mac: MAC, ssid: "GreenRoom-5G", password: "pw" });
  await tick();

  ipc.command({ type: "setTransport", mac: MAC, mode: "notx" });
  await tick();

  assert.deepEqual(provisioning.transports, [{ mac: MAC, mode: Transport.NOTX }]);
  assert.equal(store.device(MAC)?.ssid, undefined); // SSID dropped — No-TX has no network
});

test("a connecting USB device is asked for a fresh STATUS at once", async () => {
  const { app, server, provisioning } = setup();
  await app.start();
  provisioning.wired.add(MAC);

  server.connectDevice(MAC, 2);

  assert.ok(provisioning.statusRequested.includes(MAC));
});

// ── v1.3 ESP-NOW bridge designation ───────────────────────────────────────────

const BRIDGE = "bb:bb:bb:bb:bb:01";
const BRIDGE2 = "cc:cc:cc:cc:cc:02";

/** Mark a MAC wired + connected at the given version, and bring it online. */
function bringUpUsb(h: Harness, mac: string, version = 3): void {
  h.provisioning.wired.add(mac);
  h.server.connectDevice(mac, version);
}

test("designating a USB v3 device as bridge persists it, sends SET_BRIDGE 1, and routes relayed colours", async () => {
  const harness = setup();
  const { app, ipc, provisioning, store, espnow } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE);

  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();

  assert.equal(store.bridgeMac, BRIDGE, "designation is persisted");
  assert.deepEqual(provisioning.bridges, [{ mac: BRIDGE, enabled: true }], "SET_BRIDGE 1 sent");
  assert.equal(espnow.bridgeMacs.at(-1), BRIDGE, "ESP-NOW relay routing points at the bridge");
});

test("replacing the designee sends SET_BRIDGE 0 to the old and 1 to the new", async () => {
  const harness = setup();
  const { app, ipc, provisioning, store, espnow } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE);
  bringUpUsb(harness, BRIDGE2);

  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  provisioning.bridges.length = 0; // reset to isolate the replacement

  ipc.command({ type: "setBridge", mac: BRIDGE2 });
  await tick();

  assert.equal(store.bridgeMac, BRIDGE2);
  assert.deepEqual(provisioning.bridges, [
    { mac: BRIDGE, enabled: false }, // stand the old one down
    { mac: BRIDGE2, enabled: true }, // bring the new one up
  ]);
  assert.equal(espnow.bridgeMacs.at(-1), BRIDGE2);
});

test("un-designating (mac: null) sends SET_BRIDGE 0 and clears the relay routing", async () => {
  const harness = setup();
  const { app, ipc, provisioning, store, espnow } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  provisioning.bridges.length = 0;

  ipc.command({ type: "setBridge", mac: null });
  await tick();

  assert.equal(store.bridgeMac, null);
  assert.deepEqual(provisioning.bridges, [{ mac: BRIDGE, enabled: false }]);
  assert.equal(espnow.bridgeMacs.at(-1), null);
});

test("SET_BRIDGE 1 is re-asserted when the designated bridge reconnects over USB", async () => {
  const harness = setup();
  const { app, ipc, provisioning, server } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  provisioning.bridges.length = 0;

  // Cable pulled and replugged — the runtime flag was lost on the device, so the host re-asserts.
  server.disconnectDevice(BRIDGE);
  server.connectDevice(BRIDGE, 3);

  assert.deepEqual(provisioning.bridges, [{ mac: BRIDGE, enabled: true }], "re-asserted on reconnect");
});

test("a designated bridge is never sent SET_BRIDGE while it reports an older version", async () => {
  const harness = setup();
  const { app, ipc, provisioning } = harness;
  await app.start();
  // Wired but only v2 — too old for the v1.3 frames.
  bringUpUsb(harness, BRIDGE, 2);

  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();

  assert.deepEqual(provisioning.bridges, [], "no SET_BRIDGE to a sub-v3 device");
});

test("Device.bridge reflects the device-confirmed STATUS flag, not just the designation", async () => {
  const harness = setup();
  const { app, ipc, provisioning } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();

  // Designated but unconfirmed → bridge is false until STATUS confirms.
  let device = ipc.lastState()!.state.devices.find((d) => d.mac === BRIDGE)!;
  assert.equal(device.bridge, false, "designation alone doesn't set bridge");

  provisioning.emitStatus(BRIDGE, {
    mode: Transport.NOTX,
    wifiState: "idle" as DeviceWifiState,
    rssi: null,
    ssid: "",
    bridge: true, // the device confirms bridge mode
  });
  await tick();

  device = ipc.lastState()!.state.devices.find((d) => d.mac === BRIDGE)!;
  assert.equal(device.bridge, true, "confirmed STATUS flips Device.bridge");
});

test("on start the ESP-NOW transport is told the persisted bridge MAC", async () => {
  const harness = setup();
  harness.store.bridgeMac = BRIDGE; // a designation that survived a restart
  await harness.app.start();
  assert.equal(harness.espnow.bridgeMacs.at(-1), BRIDGE);
});

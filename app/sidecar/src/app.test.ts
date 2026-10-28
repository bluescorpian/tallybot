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
  type WifiScanPort,
  SidecarApp,
} from "./app.ts";
import type { SourceSnapshot } from "./engine.ts";
import type { DeviceConfig, DeviceReport } from "./store.ts";
import type {
  BridgeTxPower,
  DeviceTransport,
  DeviceWifiState,
  LogLevelName,
  SidecarEvent,
  StateEvent,
  WifiAccessPoint,
  WifiScanEvent,
} from "./ipc.ts";
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
  notice(level: LogLevelName, message: string): void {
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
  espnowChannel = 1;
  /** When set, every write fails with it (the change still lands in memory, as ConfigStore's does). */
  failWrites: Error | null = null;
  readonly #devices = new Map<string, DeviceConfig>();
  device(mac: string): DeviceConfig | undefined {
    return this.#devices.get(mac);
  }
  devices(): Array<[string, DeviceConfig]> {
    return [...this.#devices.entries()];
  }
  setSourceIp(ip: string | null): Promise<void> {
    this.sourceIp = ip;
    return this.#written();
  }
  setBridgeMac(mac: string | null): Promise<void> {
    this.bridgeMac = mac;
    return this.#written();
  }
  setEspnowChannel(channel: number): Promise<void> {
    this.espnowChannel = channel;
    return this.#written();
  }
  noteReported(mac: string, report: DeviceReport): Promise<void> {
    Object.assign(this.#ensure(mac), report);
    return this.#written();
  }
  assign(mac: string, inputId: number): Promise<void> {
    this.#ensure(mac).inputId = inputId;
    return this.#written();
  }
  unassign(mac: string): Promise<void> {
    const device = this.#devices.get(mac);
    if (device) device.inputId = null;
    return this.#written();
  }
  setBrightness(mac: string, brightness: number): Promise<void> {
    this.#ensure(mac).brightness = brightness;
    return this.#written();
  }
  setSsid(mac: string, ssid: string | null): Promise<void> {
    const device = this.#ensure(mac);
    if (ssid === null) delete device.ssid;
    else device.ssid = ssid;
    return this.#written();
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  #written(): Promise<void> {
    return this.failWrites ? Promise.reject(this.failWrites) : Promise.resolve();
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
  /** Every SET_TRANSPORT / SET_BRIDGE call with all its arguments, for the channel and power tests. */
  readonly transportCalls: Array<{ mac: string; mode: number; channel: number | null }> = [];
  readonly bridgeCalls: Array<{ mac: string; enabled: boolean; channel: number; txPower: number | undefined }> = [];
  readonly statusRequested: string[] = [];
  /** MACs currently reachable over USB (drives `transportOf` + the boolean returns). */
  readonly wired = new Set<string>();
  /** MACs the test reports as riding ESP-NOW (through a bridge). */
  readonly espnow = new Set<string>();

  transportOf(mac: string): DeviceTransport | null {
    if (this.wired.has(mac)) return "usb";
    return this.espnow.has(mac) ? "espnow" : null;
  }
  provisionWifi(mac: string, ssid: string, password: string): boolean {
    if (!this.wired.has(mac)) return false;
    this.provisioned.push({ mac, ssid, password });
    return true;
  }
  setTransport(mac: string, mode: number, channel: number | null): boolean {
    if (!this.wired.has(mac)) return false;
    this.transports.push({ mac, mode });
    this.transportCalls.push({ mac, mode, channel });
    return true;
  }
  setBridge(mac: string, enabled: boolean, channel: number, txPower?: number): boolean {
    if (!this.wired.has(mac)) return false;
    this.bridges.push({ mac, enabled });
    this.bridgeCalls.push({ mac, enabled, channel, txPower });
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
  overrides: Partial<Pick<SidecarAppDeps, "scanNetwork" | "wifiScan">> = {},
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
    refreshClock: refresh, // steppable so the keyframe re-send is deterministic (no real timer)
    log: () => {},
    scanNetwork: () => Promise.resolve([]),
    ...overrides,
    // No scan reaches a device unless a test injects one.
    wifiScan: overrides.wifiScan ?? { scanWifi: () => null },
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

test("setSource refuses a non-IPv4 address with an info notice, and neither persists nor connects", async () => {
  const { app, atem, store, ipc } = setup({
    ip: null,
    connection: "disconnected",
    programInput: null,
    previewInput: null,
    inputs: [],
  });
  await app.start();

  for (const ip of ["simulated", "256.0.0.1", "10.0.0", ""]) {
    const before = ipc.notices.length;
    ipc.command({ type: "setSource", ip });
    await tick();
    assert.equal(ipc.notices.length, before + 1, `"${ip}" raises a notice`);
    assert.equal(ipc.notices.at(-1)?.level, "info");
  }

  assert.equal(store.sourceIp, null);
  assert.deepEqual(atem.connects, []);
});

test("Device.firmware is unknown until heard from, then the reported version, which survives a reconnect", async () => {
  const { app, server, store, ipc } = setup();
  await store.assign(MAC, 1); // a light the app remembers but hasn't heard from this run
  await app.start();
  const firmwareOf = () => ipc.lastState()!.state.devices.find((d) => d.mac === MAC)!.firmware;

  assert.deepEqual(firmwareOf(), { kind: "unknown" }, "not heard from since startup");

  server.connectDevice(MAC);
  server.emit("firmware", { mac: MAC, version: "1.1.0" });
  assert.deepEqual(firmwareOf(), { kind: "reported", version: "1.1.0" });

  server.disconnectDevice(MAC);
  server.connectDevice(MAC); // its FIRMWARE hasn't arrived yet on the new link
  assert.deepEqual(firmwareOf(), { kind: "reported", version: "1.1.0" }, "a reconnect mustn't flash outdated");
});

test("an unsupported-firmware device raises a warning notice", async () => {
  const { app, server, ipc } = setup();
  await app.start();

  server.emit("deviceUnsupported", { mac: MAC, version: 0, reason: "device-too-old" });
  assert.equal(ipc.notices.at(-1)?.level, "warn");
  assert.match(ipc.notices.at(-1)!.message, /firmware/i);
});

test("a device newer than this app is told to update TallyBot, not its firmware", async () => {
  const { app, server, ipc } = setup();
  await app.start();

  server.emit("deviceUnsupported", { mac: MAC, version: 9, reason: "app-too-old" });
  const notice = ipc.notices.at(-1)!;
  assert.equal(notice.level, "warn");
  assert.match(notice.message, /update TallyBot/);
  assert.doesNotMatch(notice.message, /old firmware/i);
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

test("setTransport(espnow) is refused for a light below protocol v3, with a notice and no frame", async () => {
  const { app, server, ipc, provisioning } = setup();
  await app.start();
  provisioning.wired.add(MAC);
  server.connectDevice(MAC, 2);

  ipc.command({ type: "setTransport", mac: MAC, mode: "espnow" });
  await tick();

  assert.deepEqual(provisioning.transports, [], "nothing sent to the device");
  assert.equal(ipc.notices.at(-1)?.level, "info");
  assert.match(ipc.notices.at(-1)!.message, /ESP-NOW/);
});

test("setTransport(espnow) reaches a v3 light", async () => {
  const { app, server, ipc, provisioning } = setup();
  await app.start();
  provisioning.wired.add(MAC);
  server.connectDevice(MAC, 3);

  ipc.command({ type: "setTransport", mac: MAC, mode: "espnow" });
  await tick();

  assert.deepEqual(provisioning.transports, [{ mac: MAC, mode: Transport.ESPNOW }]);
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

// ── Failures reaching the operator ───────────────────────────────────────────

const faultsOf = (ipc: FakeIpc) => ipc.lastState()?.state.faults ?? [];
const stateCount = (ipc: FakeIpc): number => ipc.events.filter((e) => e.type === "state").length;
const noSource = (): SourceSnapshot => ({
  ip: null,
  connection: "disconnected",
  programInput: null,
  previewInput: null,
  inputs: [],
});

test("a command that throws sends an error notice and the engine keeps taking commands", async () => {
  const { app, server, ipc, provisioning, store } = setup();
  await app.start();
  provisioning.wired.add(MAC);
  server.connectDevice(MAC, 2);
  provisioning.setTransport = () => {
    throw new Error("the serial port went away");
  };

  ipc.command({ type: "setTransport", mac: MAC, mode: "wifi" });
  await tick();
  assert.equal(ipc.notices.at(-1)?.level, "error");

  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 });
  await tick();
  assert.equal(store.device(MAC)?.inputId, 1, "the next command still runs");
});

test("a failed save is a state.write error fault, the change still takes effect, and the next good save clears it", async () => {
  const { app, atem, store, ipc } = setup(noSource());
  await app.start();

  store.failWrites = new Error("EACCES: permission denied");
  ipc.command({ type: "setSource", ip: "10.0.0.9" });
  await tick();
  assert.deepEqual(atem.connects, ["10.0.0.9"], "the IP the operator typed still connects");
  assert.equal(faultsOf(ipc).find((f) => f.key === "state.write")?.level, "error");

  store.failWrites = null;
  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 });
  await tick();
  assert.equal(faultsOf(ipc).find((f) => f.key === "state.write"), undefined);
});

test("an ATEM error while connecting is an atem fault until it connects or is disconnected; while connected it isn't one", async () => {
  const { app, atem, ipc } = setup({ ...connectedSource(), connection: "connecting" });
  await app.start();
  const atemFault = () => faultsOf(ipc).find((f) => f.key === "atem");

  atem.emit("error", new Error("connect ECONNREFUSED 10.0.0.5"));
  assert.ok(atemFault(), "an error while connecting is the reason it isn't connecting");

  atem.set(connectedSource());
  assert.equal(atemFault(), undefined, "cleared once it connects");

  atem.emit("error", new Error("a mid-session hiccup"));
  assert.equal(atemFault(), undefined, "an error while connected is not a fault");

  atem.set({ ...connectedSource(), connection: "connecting" });
  atem.emit("error", new Error("connect EHOSTUNREACH 10.0.0.5"));
  assert.ok(atemFault());
  atem.set({ ...connectedSource(), connection: "disconnected" });
  assert.equal(atemFault(), undefined, "cleared when the operator disconnects");
});

test("a light's WARN/ERROR log line is its fault, holding the latest line, until it reconnects; INFO is not", async () => {
  const { app, server, ipc, provisioning } = setup();
  await app.start();
  server.connectDevice(MAC);
  const logFaults = () => faultsOf(ipc).filter((f) => f.key === `device:${MAC}:log`);

  provisioning.emit("log", { mac: MAC, level: "info", text: "bridge summary: 4 frames/s" });
  assert.deepEqual(logFaults(), []);

  provisioning.emit("log", { mac: MAC, level: "warn", text: "relink gap 3 s" });
  assert.equal(logFaults().length, 1);
  assert.equal(logFaults()[0]!.mac, MAC);
  assert.match(logFaults()[0]!.message, /relink gap 3 s/);

  const before = stateCount(ipc);
  provisioning.emit("log", { mac: MAC, level: "warn", text: "relink gap 3 s" });
  assert.equal(stateCount(ipc), before, "the same line again changes nothing, so isn't republished");
  assert.equal(logFaults().length, 1);

  provisioning.emit("log", { mac: MAC, level: "error", text: "radio init failed" });
  assert.equal(logFaults().length, 1, "one fault per light, not a growing list");
  assert.match(logFaults()[0]!.message, /radio init failed/);

  server.connectDevice(MAC); // a reconnect is a fresh session
  assert.deepEqual(logFaults(), []);
});

test("a connected light that sent no FIRMWARE reads legacy over TCP or USB, but unknown over ESP-NOW", async () => {
  const TCP = "aa:bb:cc:dd:ee:01";
  const USB = "aa:bb:cc:dd:ee:02";
  const ESPNOW = "aa:bb:cc:dd:ee:03";
  const { app, server, ipc, provisioning } = setup();
  await app.start();
  provisioning.wired.add(USB);
  provisioning.espnow.add(ESPNOW);
  for (const mac of [TCP, USB, ESPNOW]) server.connectDevice(mac, 3);
  const firmwareOf = (mac: string) => ipc.lastState()!.state.devices.find((d) => d.mac === mac)!.firmware;

  assert.deepEqual(firmwareOf(TCP), { kind: "legacy" });
  assert.deepEqual(firmwareOf(USB), { kind: "legacy" });
  // ESP-NOW is fire-and-forget: a lost FIRMWARE is no evidence of old firmware.
  assert.deepEqual(firmwareOf(ESPNOW), { kind: "unknown" });
});

test("provisionWifi refuses credentials over a light's limits with a warning, sending and storing nothing", async () => {
  const { app, server, ipc, provisioning, store } = setup();
  await app.start();
  provisioning.wired.add(MAC);
  server.connectDevice(MAC, 2);

  for (const [ssid, password] of [
    ["s".repeat(33), "hunter2"],
    ["GreenRoom-5G", "p".repeat(64)],
  ]) {
    const before = ipc.notices.length;
    ipc.command({ type: "provisionWifi", mac: MAC, ssid: ssid!, password: password! });
    await tick();
    assert.equal(ipc.notices.length, before + 1);
    assert.equal(ipc.notices.at(-1)?.level, "warn");
  }
  assert.deepEqual(provisioning.provisioned, []);
  assert.equal(store.device(MAC)?.ssid, undefined);
});

// ── Session ESP-NOW channel and bridge TX power ──────────────────────────────

/** The SET_BRIDGE calls without the txPower argument, for the channel-only assertions. */
const bridgeChannels = (p: FakeProvisioning) =>
  p.bridgeCalls.map(({ mac, enabled, channel }) => ({ mac, enabled, channel }));

test("every SET_BRIDGE and every ESP-NOW SET_TRANSPORT carries the session channel", async () => {
  const harness = setup();
  const { app, ipc, provisioning, server, store } = harness;
  store.espnowChannel = 6;
  await app.start();
  bringUpUsb(harness, MAC, 3);
  bringUpUsb(harness, BRIDGE, 4);

  ipc.command({ type: "setTransport", mac: MAC, mode: "espnow" });
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  server.disconnectDevice(BRIDGE);
  server.connectDevice(BRIDGE, 4); // the re-assert on replug

  assert.deepEqual(provisioning.transportCalls, [{ mac: MAC, mode: Transport.ESPNOW, channel: 6 }]);
  assert.deepEqual(bridgeChannels(provisioning), [
    { mac: BRIDGE, enabled: true, channel: 6 },
    { mac: BRIDGE, enabled: true, channel: 6 },
  ]);
});

test("changing the channel persists it and retunes a cabled v4 bridge with one SET_BRIDGE 1", async () => {
  const harness = setup();
  const { app, ipc, provisioning, store } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE, 4);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  provisioning.bridgeCalls.length = 0;

  ipc.command({ type: "setEspNowChannel", channel: 11 });
  await tick();

  assert.equal(store.espnowChannel, 11);
  assert.deepEqual(bridgeChannels(provisioning), [{ mac: BRIDGE, enabled: true, channel: 11 }]);
  assert.equal(ipc.lastState()!.state.espnow.channel, 11);
});

test("a v3 bridge is moved by SET_BRIDGE 0 then 1, and is never sent a txPower byte", async () => {
  const harness = setup();
  const { app, ipc, provisioning } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE, 3);
  ipc.command({ type: "setBridgeTxPower", txPower: "reduced" }); // even with reduced power set, v3 gets the 3-byte form
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  ipc.command({ type: "setEspNowChannel", channel: 11 });
  await tick();

  assert.deepEqual(bridgeChannels(provisioning).slice(1), [
    { mac: BRIDGE, enabled: false, channel: 11 },
    { mac: BRIDGE, enabled: true, channel: 11 },
  ]);
  assert.deepEqual(
    provisioning.bridgeCalls.map((c) => c.txPower),
    [undefined, undefined, undefined],
    "no SET_BRIDGE to a v3 bridge carries txPower",
  );
});

test("reduced bridge TX power sends txPower 34 to a cabled v4 bridge", async () => {
  const harness = setup();
  const { app, ipc, provisioning } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE, 4);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();

  ipc.command({ type: "setBridgeTxPower", txPower: "reduced" });
  await tick();

  const last = provisioning.bridgeCalls.at(-1);
  assert.equal(last?.enabled, true);
  assert.equal(last?.txPower, 34);
  assert.equal(ipc.lastState()!.state.espnow.bridgeTxPower, "reduced");
});

test("a channel outside 1–13 is refused with a warning: nothing stored, nothing sent", async () => {
  const harness = setup();
  const { app, ipc, provisioning, store } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE, 4);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  provisioning.bridgeCalls.length = 0;

  for (const channel of [0, 14, 2.5]) {
    const before = ipc.notices.length;
    ipc.command({ type: "setEspNowChannel", channel });
    await tick();
    assert.equal(ipc.notices.length, before + 1, `channel ${channel} raises a notice`);
    assert.equal(ipc.notices.at(-1)?.level, "warn");
  }
  assert.equal(store.espnowChannel, 1);
  assert.deepEqual(provisioning.bridgeCalls, []);
});

test("the snapshot carries each cabled device's STATUS channel, null until it reports one", async () => {
  const { app, server, ipc, provisioning } = setup();
  await app.start();
  provisioning.wired.add(MAC);
  server.connectDevice(MAC, 4);
  const channelOf = () => ipc.lastState()!.state.devices.find((d) => d.mac === MAC)!.espnowChannel;
  assert.equal(channelOf(), null);

  provisioning.emitStatus(MAC, { mode: Transport.ESPNOW, wifiState: "idle" as DeviceWifiState, rssi: null, ssid: "", channel: 6 });
  await tick();
  assert.equal(channelOf(), 6);
});

test("legacyLights names every known ESP-NOW light below v4, connected or not", async () => {
  const KNOWN_V3 = "aa:bb:cc:dd:ee:03"; // in the state file from an earlier session, not connected now
  const KNOWN_V4 = "aa:bb:cc:dd:ee:04";
  const RADIO_V3 = "aa:bb:cc:dd:ee:05"; // heard over the radio this session, then gone
  const { app, server, ipc, provisioning, store } = setup();
  await store.noteReported(KNOWN_V3, { protocolVersion: 3, transport: Transport.ESPNOW });
  await store.noteReported(KNOWN_V4, { protocolVersion: 4, transport: Transport.ESPNOW });
  await app.start();
  provisioning.espnow.add(RADIO_V3);
  server.connectDevice(RADIO_V3, 3);
  server.disconnectDevice(RADIO_V3);
  await tick();

  assert.deepEqual([...ipc.lastState()!.state.espnow.legacyLights].sort(), [KNOWN_V3, RADIO_V3]);
});

test("a restarted app starts at full bridge TX power, whatever the last session set", async () => {
  const first = setup();
  await first.app.start();
  bringUpUsb(first, BRIDGE, 4);
  first.ipc.command({ type: "setBridge", mac: BRIDGE });
  first.ipc.command({ type: "setBridgeTxPower", txPower: "reduced" });
  await tick();
  assert.equal(first.provisioning.bridgeCalls.at(-1)?.txPower, 34);

  // Relaunch on the same persisted state: the designation survives, the power setting doesn't.
  const second = setup();
  Object.assign(second.store, { bridgeMac: first.store.bridgeMac, espnowChannel: first.store.espnowChannel });
  await second.app.start();
  assert.equal(second.ipc.lastState()!.state.espnow.bridgeTxPower, "full");
  bringUpUsb(second, BRIDGE, 4); // the re-assert on connect
  assert.equal(second.provisioning.bridgeCalls.at(-1)?.txPower, 78);
});

test("an unknown bridge TX power is refused with a warning: setting kept, nothing sent", async () => {
  const harness = setup();
  const { app, ipc, provisioning } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE, 4);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  const sent = provisioning.bridgeCalls.length;
  const before = ipc.notices.length;

  ipc.command({ type: "setBridgeTxPower", txPower: "max" as BridgeTxPower });
  await tick();

  assert.equal(ipc.notices.length, before + 1);
  assert.equal(ipc.notices.at(-1)?.level, "warn");
  assert.equal(provisioning.bridgeCalls.length, sent, "no SET_BRIDGE for a refused power");
  assert.equal(ipc.lastState()!.state.espnow.bridgeTxPower, "full");
});

test("unseenLights names known devices with no recorded version unless STATUS reported WiFi or No-TX, never the bridge", async () => {
  const OLD = "aa:bb:cc:dd:ee:11"; // written by the previous app version: no version, no transport
  const OLD_ESPNOW = "aa:bb:cc:dd:ee:12"; // provisioned to ESP-NOW, version never recorded
  const OLD_SSID = "aa:bb:cc:dd:ee:13"; // an SSID kept from WiFi days: the light may be on ESP-NOW now
  const WIFI_STATUS = "aa:bb:cc:dd:ee:14";
  const NOTX = "aa:bb:cc:dd:ee:15";
  const { app, ipc, store } = setup();
  await store.assign(OLD, 1);
  await store.noteReported(OLD_ESPNOW, { transport: Transport.ESPNOW });
  await store.setSsid(OLD_SSID, "Venue");
  await store.noteReported(WIFI_STATUS, { transport: Transport.WIFI });
  await store.noteReported(NOTX, { transport: Transport.NOTX });
  await store.assign(BRIDGE, 2);
  store.bridgeMac = BRIDGE;
  await app.start();

  const { unseenLights, legacyLights } = ipc.lastState()!.state.espnow;
  assert.deepEqual([...unseenLights].sort(), [OLD, OLD_ESPNOW, OLD_SSID]);
  assert.deepEqual(legacyLights, []);
});

test("the designated bridge is left out of legacyLights even below v4", async () => {
  const LIGHT_V3 = "aa:bb:cc:dd:ee:16";
  const { app, ipc, store } = setup();
  await store.noteReported(BRIDGE, { protocolVersion: 3, transport: Transport.ESPNOW });
  await store.noteReported(LIGHT_V3, { protocolVersion: 3, transport: Transport.ESPNOW });
  store.bridgeMac = BRIDGE;
  await app.start();

  assert.deepEqual(ipc.lastState()!.state.espnow.legacyLights, [LIGHT_V3]);
});

test("a light leaves the warning lists on reconnect: unseen once it reports any version, legacy at v4", async () => {
  const UNSEEN_V3 = "aa:bb:cc:dd:ee:21";
  const UNSEEN_V4 = "aa:bb:cc:dd:ee:22";
  const LEGACY = "aa:bb:cc:dd:ee:23";
  const { app, server, ipc, provisioning, store } = setup();
  await store.assign(UNSEEN_V3, 1);
  await store.assign(UNSEEN_V4, 2);
  await store.noteReported(LEGACY, { protocolVersion: 3, transport: Transport.ESPNOW });
  await app.start();
  const espnowOf = () => ipc.lastState()!.state.espnow;
  assert.deepEqual([...espnowOf().unseenLights].sort(), [UNSEEN_V3, UNSEEN_V4]);
  assert.deepEqual(espnowOf().legacyLights, [LEGACY]);

  for (const [mac, version] of [
    [UNSEEN_V3, 3],
    [UNSEEN_V4, 4],
    [LEGACY, 4], // updated firmware
  ] as const) {
    provisioning.espnow.add(mac);
    server.connectDevice(mac, version);
  }
  await tick();

  assert.deepEqual(espnowOf().unseenLights, []);
  assert.deepEqual(espnowOf().legacyLights, [UNSEEN_V3]);
});

test("a device that leaves USB but stays online drops its USB-only state", async () => {
  const harness = setup();
  const { app, server, ipc, provisioning } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE, 4);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  provisioning.emitStatus(BRIDGE, {
    mode: Transport.ESPNOW,
    wifiState: "idle" as DeviceWifiState,
    rssi: -40,
    ssid: "",
    channel: 6,
    bridge: true,
  });
  await tick();
  const deviceOf = () => ipc.lastState()!.state.devices.find((d) => d.mac === BRIDGE)!;
  assert.equal(deviceOf().espnowChannel, 6);
  assert.equal(deviceOf().bridge, true);

  // Unplugged, but still reachable over TCP: the composite re-announces it without a disconnect.
  provisioning.wired.delete(BRIDGE);
  server.connectDevice(BRIDGE, 4);
  await tick();

  const device = deviceOf();
  assert.equal(device.espnowChannel, null);
  assert.equal(device.bridge, false);
  assert.equal(device.wifiState, null);
  assert.equal(device.rssi, null);
  assert.equal(device.provisionedMode ?? null, null);
});

// ── v1.4 ESP-NOW channel scan ────────────────────────────────────────────────────

const LIGHT = "dd:dd:dd:dd:dd:03";

/** A WifiScanPort that records who was asked and answers with `answer` (a scan's outcome). */
function fakeWifiScan(answer: () => Promise<WifiAccessPoint[]> = () => Promise.resolve([])): WifiScanPort & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    scanWifi(mac) {
      asked.push(mac);
      return answer();
    },
  };
}

function wifiScans(ipc: FakeIpc): WifiScanEvent[] {
  return ipc.events.filter((e): e is WifiScanEvent => e.type === "wifiScan");
}

test("a channel scan runs on a cabled v4 light rather than the bridge, and never on a v3 light", async () => {
  const wifiScan = fakeWifiScan();
  const harness = setup(connectedSource(), { wifiScan });
  const { app, ipc } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE, 4);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  bringUpUsb(harness, MAC, 3);
  bringUpUsb(harness, LIGHT, 4);
  await tick();

  ipc.command({ type: "scanWifi" });
  await tick();

  assert.deepEqual(wifiScan.asked, [LIGHT]);
  const done = wifiScans(ipc).at(-1)!;
  assert.equal(done.status, "done");
  assert.deepEqual(done.scanner, { mac: LIGHT, bridge: false });
  assert.equal(done.error, null);
});

test("with only the bridge able to scan, the scan runs on it and says it was the bridge", async () => {
  const wifiScan = fakeWifiScan();
  const harness = setup(connectedSource(), { wifiScan });
  const { app, ipc } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE, 4);
  ipc.command({ type: "setBridge", mac: BRIDGE });
  bringUpUsb(harness, MAC, 3);
  await tick();

  ipc.command({ type: "scanWifi" });
  await tick();

  assert.deepEqual(wifiScan.asked, [BRIDGE]);
  assert.deepEqual(wifiScans(ipc).at(-1)!.scanner, { mac: BRIDGE, bridge: true });
});

test("with no cabled light, or only one too old to scan, the UI gets an error saying which and nothing is asked", async () => {
  const wifiScan = fakeWifiScan();
  const harness = setup(connectedSource(), { wifiScan });
  const { app, ipc, server } = harness;
  await app.start();
  server.connectDevice(LIGHT, 4); // online, but not over USB

  ipc.command({ type: "scanWifi" });
  await tick();
  const none = wifiScans(ipc).at(-1)!;
  assert.equal(none.status, "done");
  assert.equal(none.scanner, null);
  assert.match(none.error ?? "", /USB/);

  bringUpUsb(harness, MAC, 3);
  ipc.command({ type: "scanWifi" });
  await tick();
  const old = wifiScans(ipc).at(-1)!;
  assert.equal(old.scanner, null);
  assert.match(old.error ?? "", /firmware/);
  assert.notEqual(old.error, none.error);

  assert.deepEqual(wifiScan.asked, []);
});

test("a second scan request while one runs does not start another scan", async () => {
  let finish!: (aps: WifiAccessPoint[]) => void;
  const wifiScan = fakeWifiScan(() => new Promise((resolve) => (finish = resolve)));
  const harness = setup(connectedSource(), { wifiScan });
  const { app, ipc } = harness;
  await app.start();
  bringUpUsb(harness, LIGHT, 4);

  ipc.command({ type: "scanWifi" });
  ipc.command({ type: "scanWifi" });
  await tick();
  assert.deepEqual(wifiScan.asked, [LIGHT]);

  finish([]);
  await tick();
  ipc.command({ type: "scanWifi" }); // once it's done, a new request runs
  await tick();
  assert.deepEqual(wifiScan.asked, [LIGHT, LIGHT]);
});

test("a failed device scan is reported as an error, not as a quiet band with a suggestion", async () => {
  const wifiScan = fakeWifiScan(() => Promise.reject(new Error("no complete scan result within 10 s")));
  const harness = setup(connectedSource(), { wifiScan });
  const { app, ipc } = harness;
  await app.start();
  bringUpUsb(harness, LIGHT, 4);

  ipc.command({ type: "scanWifi" });
  await tick();

  const done = wifiScans(ipc).at(-1)!;
  assert.equal(done.status, "done");
  assert.deepEqual(done.scanner, { mac: LIGHT, bridge: false });
  assert.notEqual(done.error, null);
  assert.equal(done.suggestedChannel, null);
  assert.deepEqual(done.congestion, []);
});

test("congestion scores each channel 1–13 by RSSI-weighted APs within ±4, and suggests the quietest of 1, 6, 11, 13", async () => {
  // Weight = clamp((rssi + 100) / 70, 0, 1): -20 → 1 (clamped), -65 → 0.5, -110 → 0 (clamped).
  const heard: WifiAccessPoint[] = [
    { channel: 6, rssi: -20, ssid: "in-room" },
    { channel: 1, rssi: -65, ssid: "next-door" },
    { channel: 13, rssi: -110, ssid: "edge" },
  ];
  const wifiScan = fakeWifiScan(() => Promise.resolve(heard));
  const harness = setup(connectedSource(), { wifiScan });
  const { app, ipc } = harness;
  await app.start();
  bringUpUsb(harness, LIGHT, 4);

  ipc.command({ type: "scanWifi" });
  await tick();

  const done = wifiScans(ipc).at(-1)!;
  //            ch:  1    2    3    4    5    6  7  8  9 10 11 12 13
  const expected = [0.5, 1.5, 1.5, 1.5, 1.5, 1, 1, 1, 1, 1, 0, 0, 0];
  assert.deepEqual(
    done.congestion.map((c) => [c.channel, c.score]),
    expected.map((score, i) => [i + 1, score]),
  );
  // 11 and 13 tie at 0; the session channel (1) isn't among them, so the lower one wins.
  assert.equal(done.suggestedChannel, 11);
});

test("a tie among the quietest candidates keeps the current session channel", async () => {
  const wifiScan = fakeWifiScan(() => Promise.resolve([{ channel: 3, rssi: -30, ssid: "busy" }]));
  const harness = setup(connectedSource(), { wifiScan });
  const { app, ipc, store } = harness;
  store.espnowChannel = 13; // 11 and 13 both score 0
  await app.start();
  bringUpUsb(harness, LIGHT, 4);

  ipc.command({ type: "scanWifi" });
  await tick();

  assert.equal(wifiScans(ipc).at(-1)!.suggestedChannel, 13);
});

const scannerOf = (ipc: FakeIpc) => ipc.lastState()!.state.espnow.scanner;

test("the snapshot names who a scan would run on as cabled devices come, go and leave USB", async () => {
  const harness = setup();
  const { app, ipc, server, provisioning } = harness;
  await app.start();
  assert.equal(scannerOf(ipc), null, "nothing cabled");

  bringUpUsb(harness, MAC, 3);
  await tick();
  assert.equal(scannerOf(ipc), null, "a v3 device can't scan");

  bringUpUsb(harness, LIGHT, 4);
  await tick();
  assert.deepEqual(scannerOf(ipc), { mac: LIGHT, bridge: false });

  // Unplugged, but still reachable over TCP: the composite re-announces it without a disconnect.
  provisioning.wired.delete(LIGHT);
  server.connectDevice(LIGHT, 4);
  await tick();
  assert.equal(scannerOf(ipc), null, "off USB, it can't scan");

  bringUpUsb(harness, LIGHT, 4);
  await tick();
  assert.deepEqual(scannerOf(ipc), { mac: LIGHT, bridge: false }, "back on USB");

  server.disconnectDevice(LIGHT);
  await tick();
  assert.equal(scannerOf(ipc), null, "gone");
});

test("the snapshot's scanner prefers a non-bridge light, and marks a designated bridge when only it can scan", async () => {
  const harness = setup();
  const { app, ipc, server } = harness;
  await app.start();
  bringUpUsb(harness, BRIDGE, 4);
  await tick();
  assert.deepEqual(scannerOf(ipc), { mac: BRIDGE, bridge: false }, "not yet the bridge");

  ipc.command({ type: "setBridge", mac: BRIDGE });
  await tick();
  assert.deepEqual(scannerOf(ipc), { mac: BRIDGE, bridge: true });

  bringUpUsb(harness, LIGHT, 4);
  await tick();
  assert.deepEqual(scannerOf(ipc), { mac: LIGHT, bridge: false });

  server.disconnectDevice(LIGHT);
  await tick();
  assert.deepEqual(scannerOf(ipc), { mac: BRIDGE, bridge: true });
});

test("a device whose STATUS confirms it is bridging counts as the bridge in the snapshot's scanner", async () => {
  const harness = setup();
  const { app, ipc, provisioning } = harness;
  await app.start();
  bringUpUsb(harness, LIGHT, 4);
  await tick();
  assert.deepEqual(scannerOf(ipc), { mac: LIGHT, bridge: false });

  provisioning.emitStatus(LIGHT, { mode: Transport.ESPNOW, wifiState: "idle", rssi: null, ssid: "", channel: 1, bridge: true });
  await tick();
  assert.deepEqual(scannerOf(ipc), { mac: LIGHT, bridge: true });
});

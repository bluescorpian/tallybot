import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  type AtemSourcePort,
  type BlinkClock,
  type DeviceServerPort,
  type IpcPort,
  type SidecarAppDeps,
  type StorePort,
  SidecarApp,
} from "./app.ts";
import type { SourceSnapshot } from "./engine.ts";
import type { DeviceConfig } from "./store.ts";
import type { SidecarEvent, StateEvent } from "./ipc.ts";
import { type Color, COLORS, DEFAULT_BRIGHTNESS, SETUP_COLOR } from "./protocol.ts";

// ── In-memory fakes for the orchestrator's ports ─────────────────────────────────

class FakeDeviceServer extends EventEmitter implements DeviceServerPort {
  readonly sent: Array<{ mac: string; color: Color; brightness: number }> = [];
  readonly identified: string[] = [];
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
  identify(mac: string): boolean {
    if (!this.#connected.has(mac)) return false;
    this.identified.push(mac);
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

/** A blink clock the test steps by hand, so flashing is deterministic (no wall clock). */
class FakeBlinkClock implements BlinkClock {
  #tick: (() => void) | null = null;
  start(_intervalMs: number, tick: () => void): () => void {
    this.#tick = tick;
    return () => {
      this.#tick = null;
    };
  }
  /** True while a blink is armed. */
  get running(): boolean {
    return this.#tick !== null;
  }
  /** Advance one half-cycle (toggles the lit/dark phase). */
  step(): void {
    this.#tick?.();
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

const MAC = "aa:bb:cc:dd:ee:01";

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
  blink: FakeBlinkClock;
}

function setup(
  source: SourceSnapshot = connectedSource(),
  overrides: Partial<Pick<SidecarAppDeps, "scanNetwork">> = {},
): Harness {
  const server = new FakeDeviceServer();
  const atem = new FakeAtemSource(source);
  const ipc = new FakeIpc();
  const store = new FakeStore();
  const blink = new FakeBlinkClock();
  const app = new SidecarApp({
    atem,
    deviceServer: server,
    store,
    ipc,
    blinkClock: blink,
    log: () => {},
    ...overrides,
  });
  return { app, server, atem, ipc, store, blink };
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
  const { app, server, atem, ipc, blink } = setup(); // connected, program 1
  await app.start();
  server.connectDevice(MAC);
  ipc.command({ type: "assignDevice", mac: MAC, inputId: 1 });
  await tick();
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.live, "healthy source → live red");
  assert.equal(blink.running, false, "no fault, no blink");

  // The ATEM drops (inputs retained, but the connection is gone).
  atem.set({ ...connectedSource(), connection: "disconnected" });
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.disconnected, "fault is blue, not idle green");
  assert.notDeepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.idle);
  assert.equal(blink.running, true, "the blink is armed");

  // Stepping the clock pulses the LED off, then back to blue — i.e. it flashes.
  blink.step();
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, { r: 0, g: 0, b: 0 }, "dark phase");
  blink.step();
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.disconnected, "lit phase again");

  // Source recovers → back to a steady live red and the blink stops.
  atem.set(connectedSource());
  assert.deepEqual(server.sentTo(MAC).at(-1)?.color, COLORS.live);
  assert.equal(blink.running, false, "recovery disarms the blink");
});

test("identify reaches a connected device, and warns when offline", async () => {
  const { app, server, ipc } = setup();
  await app.start();

  ipc.command({ type: "identifyDevice", mac: MAC }); // not connected yet
  await tick();
  assert.equal(server.identified.length, 0);
  assert.equal(ipc.notices.at(-1)?.level, "info");

  server.connectDevice(MAC);
  ipc.command({ type: "identifyDevice", mac: MAC });
  await tick();
  assert.deepEqual(server.identified, [MAC]);
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

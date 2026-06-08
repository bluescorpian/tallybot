/**
 * The orchestrator — the sidecar's wiring loop.
 *
 * Everything else is a piece with a single job; this is the part that holds them
 * together and owns the mutable picture of the world. It merges the live facts (who
 * is connected, what the ATEM reports) with the persisted ones (assignments,
 * brightness), runs the pure {@link computeEngine} over that merge, and then acts on
 * the result twice: it pushes a `SET_COLOR` to any device whose target colour
 * actually changed (diffed against what we last sent, so reconnecting a device or
 * nudging one input doesn't spray the whole rig), and it emits the fresh snapshot to
 * the UI.
 *
 * The collaborators are reached through narrow **ports** (interfaces below) rather
 * than the concrete classes, so the orchestrator can be unit-tested with in-memory
 * fakes and never has to open a socket to prove its logic (`app.test.ts`).
 */

import {
  type DeviceColor,
  type DeviceRecord,
  type SourceSnapshot,
  INACTIVE_GATE,
  computeEngine,
} from "./engine.ts";
import type { DeviceConfig } from "./store.ts";
import type { SidecarEvent, SourceScanHit, UiCommand } from "./ipc.ts";
import { scanNetwork } from "./scanner.ts";
import { type Color, DEFAULT_BRIGHTNESS, macTail } from "./protocol.ts";

// ── Collaborator ports (the concrete classes satisfy these structurally) ─────────

export interface DeviceServerPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendColor(mac: string, color: Color, brightness: number): boolean;
  identify(mac: string): boolean;
  on(event: "deviceConnected", listener: (info: { mac: string; version: number }) => void): unknown;
  on(event: "deviceDisconnected", listener: (info: { mac: string }) => void): unknown;
  on(event: "deviceUnsupported", listener: (info: { mac: string; version: number }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface AtemSourcePort {
  snapshot(): SourceSnapshot;
  connect(ip: string): void;
  disconnect(): Promise<void>;
  on(event: "change", listener: (snapshot: SourceSnapshot) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface StorePort {
  readonly sourceIp: string | null;
  device(mac: string): DeviceConfig | undefined;
  devices(): Array<[string, DeviceConfig]>;
  setSourceIp(ip: string | null): Promise<void>;
  assign(mac: string, inputId: number): Promise<void>;
  unassign(mac: string): Promise<void>;
  setBrightness(mac: string, brightness: number): Promise<void>;
  /** Resolve once all queued writes have been flushed to disk. */
  flush(): Promise<void>;
}

export interface IpcPort {
  send(event: SidecarEvent): void;
  notice(level: "info" | "warn" | "error", message: string): void;
  on(event: "command", listener: (command: UiCommand) => void): unknown;
  close(): void;
}

/**
 * Drives connected-state animation (the fault flash and the unassigned breathe). The pure
 * engine only *names* a device's animation; the orchestrator ticks a single clock and derives
 * every animated device's current frame from the elapsed time. Injectable so tests step it
 * deterministically instead of waiting on the wall clock. `start` begins ticking and returns a
 * function that stops it.
 */
export interface AnimationClock {
  start(intervalMs: number, tick: () => void): () => void;
}

const realAnimationClock: AnimationClock = {
  start(intervalMs, tick) {
    const handle = setInterval(tick, intervalMs);
    handle.unref(); // animation must never keep the process alive on its own
    return () => clearInterval(handle);
  },
};

/**
 * Animation tick. Small enough for a smooth breathe; the flash and breathe phases are derived
 * from elapsed time, not per-tick, so this rate is independent of either's period.
 */
const ANIM_TICK_MS = 100;
/** Half the fault-flash cycle — lit for this long, then dark, giving the ~1 Hz flash. */
const FLASH_HALF_MS = 500;
/** Full breathe cycle for the unassigned state (docs/led.md state 5): a slow, calm swell. */
const BREATHE_PERIOD_MS = 10_000;
/** The breathe dims to this fraction of the device's brightness at its trough — never fully off. */
const BREATHE_FLOOR = 0.1;
/** The "off" phase of the fault flash — the LED dark between blue pulses. */
const FLASH_OFF: Color = { r: 0, g: 0, b: 0 };

/**
 * The brightness to drive a breathing device this tick: its configured brightness modulated by
 * a raised cosine over {@link BREATHE_PERIOD_MS}, from {@link BREATHE_FLOOR} up to full and back.
 * Starts at the trough so a device that has just appeared fades up rather than popping on.
 */
function breatheBrightness(elapsedMs: number, base: number): number {
  const phase = (elapsedMs % BREATHE_PERIOD_MS) / BREATHE_PERIOD_MS; // 0..1
  const wave = (1 - Math.cos(2 * Math.PI * phase)) / 2; // 0 → 1 → 0, starting low
  return Math.round(base * (BREATHE_FLOOR + (1 - BREATHE_FLOOR) * wave));
}

export interface SidecarAppDeps {
  atem: AtemSourcePort;
  deviceServer: DeviceServerPort;
  store: StorePort;
  ipc: IpcPort;
  /** Where to log diagnostics (defaults to stderr; stdout is protocol-only). */
  log?: (message: string) => void;
  /** Override the animation timer (tests inject a steppable clock). */
  animClock?: AnimationClock;
  /** Override the animation tick in ms (default {@link ANIM_TICK_MS}); each step advances elapsed time by this. */
  animTickMs?: number;
  /** The subnet sweep behind the settings "Scan" (injectable so tests don't open sockets). */
  scanNetwork?: (log: (message: string) => void) => Promise<SourceScanHit[]>;
  /**
   * Mark every snapshot as dev mode (running against the fake ATEM). The UI reads this
   * to make the board's input keys clickable. Set only by the fake-ATEM dev entry;
   * production leaves it false.
   */
  dev?: boolean;
}

function colorsEqual(a: { color: Color; brightness: number }, b: { color: Color; brightness: number }): boolean {
  return (
    a.brightness === b.brightness &&
    a.color.r === b.color.r &&
    a.color.g === b.color.g &&
    a.color.b === b.color.b
  );
}

export class SidecarApp {
  readonly #atem: AtemSourcePort;
  readonly #server: DeviceServerPort;
  readonly #store: StorePort;
  readonly #ipc: IpcPort;
  readonly #log: (message: string) => void;
  readonly #animClock: AnimationClock;
  readonly #animTickMs: number;
  readonly #scanNetwork: (log: (message: string) => void) => Promise<SourceScanHit[]>;
  readonly #dev: boolean;

  /** True while a subnet sweep is in flight — a second "Scan" is ignored until it ends. */
  #scanning = false;

  /** Connected devices → their reported protocol version (present only while online). */
  readonly #online = new Map<string, number>();
  /** The last colour pushed to each device, to suppress redundant SET_COLORs. */
  readonly #lastColor = new Map<string, { color: Color; brightness: number }>();

  /** Stops the animation clock, or null when nothing is currently animated. */
  #stopAnim: (() => void) | null = null;
  /** Elapsed animation time (ms); the flash phase and breathe envelope are both derived from it. */
  #animMs = 0;

  #source: SourceSnapshot;
  // The override layer is modelled from v1 but stays inactive until a source wires it.
  readonly #gate = INACTIVE_GATE;

  constructor(deps: SidecarAppDeps) {
    this.#atem = deps.atem;
    this.#server = deps.deviceServer;
    this.#store = deps.store;
    this.#ipc = deps.ipc;
    this.#log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.#animClock = deps.animClock ?? realAnimationClock;
    this.#animTickMs = deps.animTickMs ?? ANIM_TICK_MS;
    this.#scanNetwork = deps.scanNetwork ?? scanNetwork;
    this.#dev = deps.dev ?? false;
    this.#source = deps.atem.snapshot();

    this.#ipc.on("command", (command) => void this.#handleCommand(command));

    this.#server.on("deviceConnected", ({ mac, version }) => {
      this.#online.set(mac, version);
      this.#lastColor.delete(mac); // reconnect may skip the disconnect event; always re-push
      this.#log(`device connected: ${mac} (protocol v${version})`);
      this.#sync();
    });
    this.#server.on("deviceDisconnected", ({ mac }) => {
      this.#online.delete(mac);
      this.#lastColor.delete(mac); // forget it, so a reconnect is sent its colour afresh
      this.#log(`device disconnected: ${mac}`);
      this.#sync();
    });
    this.#server.on("deviceUnsupported", ({ mac, version }) => {
      this.#ipc.notice("warn", `Tally ${macTail(mac)} runs old firmware (protocol v${version}); update it.`);
    });
    this.#server.on("error", (err) => this.#log(`device server error: ${err.message}`));

    this.#atem.on("change", (snapshot) => {
      this.#source = snapshot;
      this.#sync();
    });
    this.#atem.on("error", (err) => this.#log(`ATEM error: ${err.message}`));
  }

  /** Start the device server and connect to the saved ATEM, then emit a first snapshot. */
  async start(): Promise<void> {
    await this.#server.start();
    const ip = this.#store.sourceIp;
    if (ip) this.#atem.connect(ip); // emits a `change` that will publish; #sync below covers the no-ip case
    this.#sync();
  }

  /** Shut down cleanly: stop the animation clock, the server, the ATEM, flush pending writes. */
  async stop(): Promise<void> {
    this.#setAnimating(false);
    this.#ipc.close();
    await this.#atem.disconnect();
    await this.#server.stop();
    await this.#store.flush();
  }

  // ── Commands from the UI ─────────────────────────────────────────────────────

  async #handleCommand(command: UiCommand): Promise<void> {
    switch (command.type) {
      case "assignDevice":
        await this.#store.assign(command.mac, command.inputId);
        this.#sync();
        break;
      case "unassignDevice":
        await this.#store.unassign(command.mac);
        this.#sync();
        break;
      case "identifyDevice":
        if (!this.#server.identify(command.mac)) {
          this.#ipc.notice("info", `Tally ${macTail(command.mac, 2)} is offline — can't flash it.`);
        }
        break;
      case "setBrightness":
        await this.#store.setBrightness(command.mac, command.brightness);
        this.#sync();
        break;
      case "setSource":
        await this.#store.setSourceIp(command.ip);
        this.#atem.connect(command.ip); // change event publishes the new connecting state
        break;
      case "scanSources":
        void this.#scan();
        break;
      case "requestState":
        // The UI just (re)connected its listener — replay the current snapshot so it
        // doesn't sit on stale/empty state waiting for the next change. (#sync re-pushes
        // colours too, but the diff in #pushColor keeps a steady rig quiet.)
        this.#sync();
        break;
    }
  }

  /**
   * Run the subnet sweep behind the settings "Scan". Fire-and-forget: emits a
   * `scanning` event up front and a `done` event with the results (or an `error`)
   * when it finishes. Overlapping scans are dropped so a double-click can't run two.
   */
  async #scan(): Promise<void> {
    if (this.#scanning) return;
    this.#scanning = true;
    this.#ipc.send({ type: "sourceScan", status: "scanning", found: [], error: null });
    try {
      const found = await this.#scanNetwork(this.#log);
      this.#ipc.send({ type: "sourceScan", status: "done", found, error: null });
    } catch (err) {
      this.#ipc.send({ type: "sourceScan", status: "done", found: [], error: (err as Error).message });
    } finally {
      this.#scanning = false;
    }
  }

  // ── The core loop: merge → compute → send diffs + publish ────────────────────────

  /** Every device we know of: connected ones unioned with those that have saved config. */
  #deviceRecords(): DeviceRecord[] {
    const macs = new Set<string>([...this.#online.keys(), ...this.#store.devices().map(([mac]) => mac)]);
    const records: DeviceRecord[] = [];
    for (const mac of macs) {
      const config = this.#store.device(mac);
      records.push({
        mac,
        macTail: macTail(mac),
        online: this.#online.has(mac),
        protocolVersion: this.#online.get(mac) ?? null,
        inputId: config?.inputId ?? null,
        brightness: config?.brightness ?? DEFAULT_BRIGHTNESS,
      });
    }
    return records;
  }

  #sync(): void {
    const { state, colors } = computeEngine(this.#source, this.#gate, this.#deviceRecords());
    this.#applyColors(colors);
    this.#ipc.send({ type: "state", state: this.#dev ? { ...state, dev: true } : state });
  }

  /**
   * Push each device's target frame (resolving the current animation phase for flashing /
   * breathing ones from {@link #animMs}) and arm or disarm the animation clock to match. Called
   * on every real change and on every animation tick; the diff in {@link #pushColor} keeps a
   * steady rig quiet — only animated devices re-send.
   */
  #applyColors(colors: ReadonlyArray<DeviceColor>): void {
    let anyAnimated = false;
    for (const target of colors) {
      switch (target.anim) {
        case "flash": {
          anyAnimated = true;
          // Lit for the first half of each cycle, dark for the second — the ~1 Hz fault flash.
          const lit = Math.floor(this.#animMs / FLASH_HALF_MS) % 2 === 0;
          this.#pushColor({ mac: target.mac, color: lit ? target.color : FLASH_OFF, brightness: target.brightness });
          break;
        }
        case "breathe": {
          anyAnimated = true;
          // Colour held; brightness swells in a slow sine — the unassigned "alive, waiting" state.
          const brightness = breatheBrightness(this.#animMs, target.brightness);
          this.#pushColor({ mac: target.mac, color: target.color, brightness });
          break;
        }
        default:
          this.#pushColor({ mac: target.mac, color: target.color, brightness: target.brightness });
      }
    }
    this.#setAnimating(anyAnimated);
  }

  /** Start the animation clock when the first animated device appears, stop it when the last clears. */
  #setAnimating(on: boolean): void {
    if (on && !this.#stopAnim) {
      this.#stopAnim = this.#animClock.start(this.#animTickMs, () => this.#tickAnim());
    } else if (!on && this.#stopAnim) {
      this.#stopAnim();
      this.#stopAnim = null;
      this.#animMs = 0; // next animation starts from a clean phase (flash lit, breathe at its trough)
    }
  }

  /** Advance animation time and re-push colours — but emit no UI snapshot for a mere animation tick. */
  #tickAnim(): void {
    this.#animMs += this.#animTickMs;
    const { colors } = computeEngine(this.#source, this.#gate, this.#deviceRecords());
    this.#applyColors(colors);
  }

  /** Send SET_COLOR only when the device's target colour actually changed. */
  #pushColor(target: { mac: string; color: Color; brightness: number }): void {
    const last = this.#lastColor.get(target.mac);
    if (last && colorsEqual(last, target)) return;
    if (this.#server.sendColor(target.mac, target.color, target.brightness)) {
      this.#lastColor.set(target.mac, { color: target.color, brightness: target.brightness });
    }
  }
}

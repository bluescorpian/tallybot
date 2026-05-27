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
import type { SidecarEvent, UiCommand } from "./ipc.ts";
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
 * Drives the fault blink. The pure engine flags a device as flashing but has no
 * clock; the orchestrator pulses it on this timer. Injectable so tests step the blink
 * deterministically instead of waiting on the wall clock. `start` begins ticking and
 * returns a function that stops it.
 */
export interface BlinkClock {
  start(intervalMs: number, tick: () => void): () => void;
}

const realBlinkClock: BlinkClock = {
  start(intervalMs, tick) {
    const handle = setInterval(tick, intervalMs);
    handle.unref(); // a blinking fault must never keep the process alive on its own
    return () => clearInterval(handle);
  },
};

/** Half a blink cycle: toggling every 500 ms gives the ~1 Hz fault flash. */
const BLINK_INTERVAL_MS = 500;
/** The "off" phase of the fault blink — the LED dark between blue pulses. */
const FLASH_OFF: Color = { r: 0, g: 0, b: 0 };

export interface SidecarAppDeps {
  atem: AtemSourcePort;
  deviceServer: DeviceServerPort;
  store: StorePort;
  ipc: IpcPort;
  /** Where to log diagnostics (defaults to stderr; stdout is protocol-only). */
  log?: (message: string) => void;
  /** Override the fault-blink timer (tests inject a steppable clock). */
  blinkClock?: BlinkClock;
  /** Override the blink half-cycle in ms (default {@link BLINK_INTERVAL_MS}). */
  blinkIntervalMs?: number;
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
  readonly #blinkClock: BlinkClock;
  readonly #blinkIntervalMs: number;

  /** Connected devices → their reported protocol version (present only while online). */
  readonly #online = new Map<string, number>();
  /** The last colour pushed to each device, to suppress redundant SET_COLORs. */
  readonly #lastColor = new Map<string, { color: Color; brightness: number }>();

  /** Stops the fault blink, or null when nothing is currently flashing. */
  #stopBlink: (() => void) | null = null;
  /** Current blink phase: false = lit (show the fault colour), true = dark. */
  #blinkPhase = false;

  #source: SourceSnapshot;
  // The override layer is modelled from v1 but stays inactive until a source wires it.
  readonly #gate = INACTIVE_GATE;

  constructor(deps: SidecarAppDeps) {
    this.#atem = deps.atem;
    this.#server = deps.deviceServer;
    this.#store = deps.store;
    this.#ipc = deps.ipc;
    this.#log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.#blinkClock = deps.blinkClock ?? realBlinkClock;
    this.#blinkIntervalMs = deps.blinkIntervalMs ?? BLINK_INTERVAL_MS;
    this.#source = deps.atem.snapshot();

    this.#ipc.on("command", (command) => void this.#handleCommand(command));

    this.#server.on("deviceConnected", ({ mac, version }) => {
      this.#online.set(mac, version);
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

  /** Shut down cleanly: stop the blink, the server, the ATEM, flush pending writes. */
  async stop(): Promise<void> {
    this.#setBlinking(false);
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
          this.#ipc.notice("info", `Tally ${macTail(command.mac)} is offline — can't flash it.`);
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
    this.#ipc.send({ type: "state", state });
  }

  /**
   * Push each device's target colour (resolving the current blink phase for flashing
   * ones) and arm or disarm the blink timer to match. Called on every real change and
   * on every blink tick; the diff in {@link #pushColor} keeps a steady rig quiet.
   */
  #applyColors(colors: ReadonlyArray<DeviceColor>): void {
    let anyFlashing = false;
    for (const target of colors) {
      if (target.flashing) {
        anyFlashing = true;
        // Lit phase shows the fault colour; dark phase blanks the LED.
        const color = this.#blinkPhase ? FLASH_OFF : target.color;
        this.#pushColor({ mac: target.mac, color, brightness: target.brightness });
      } else {
        this.#pushColor({ mac: target.mac, color: target.color, brightness: target.brightness });
      }
    }
    this.#setBlinking(anyFlashing);
  }

  /** Start the blink timer when a fault appears, stop it when the last one clears. */
  #setBlinking(on: boolean): void {
    if (on && !this.#stopBlink) {
      this.#stopBlink = this.#blinkClock.start(this.#blinkIntervalMs, () => this.#tickBlink());
    } else if (!on && this.#stopBlink) {
      this.#stopBlink();
      this.#stopBlink = null;
      this.#blinkPhase = false; // so the next fault starts on the lit phase
    }
  }

  /** Flip the blink phase and re-push colours — but emit no UI snapshot for a mere blink. */
  #tickBlink(): void {
    this.#blinkPhase = !this.#blinkPhase;
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

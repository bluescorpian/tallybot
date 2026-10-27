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
import type { DeviceTransportEvents } from "./device-events.ts";
import { FaultBook, type FaultReport, describeError } from "./faults.ts";
import type { DeviceConfig } from "./store.ts";
import type { DeviceFirmware, DeviceTransport, DeviceWifiState, LogLevelName, SidecarEvent, SourceScanHit, UiCommand } from "./ipc.ts";
import {
  type Color,
  DEFAULT_BRIGHTNESS,
  HOST_SILENCE_TIMEOUT_MS,
  isIPv4,
  macTail,
  supportsEspNow,
  wifiCredentialsProblem,
} from "./protocol.ts";
import { provisionedModeName, transportModeValue } from "./usb-transport.ts";

// ── Collaborator ports (the concrete classes satisfy these structurally) ─────────

export interface DeviceServerPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendColor(mac: string, color: Color, brightness: number): boolean;
  /** The shared per-device events ({@link DeviceTransportEvents}). */
  on<K extends keyof DeviceTransportEvents>(event: K, listener: (...args: DeviceTransportEvents[K]) => void): unknown;
}

/**
 * The USB-only provisioning + diagnostics surface, kept separate from the
 * transport-agnostic {@link DeviceServerPort} so the tally path stays clean. The
 * {@link CompositeDeviceServer} implements both (its methods return false for a MAC not on USB).
 */
export interface ProvisioningPort {
  /** Which transport currently serves a connected MAC (drives the wired indicator). */
  transportOf(mac: string): DeviceTransport | null;
  /** Provision WiFi creds over USB and trigger a validating join. */
  provisionWifi(mac: string, ssid: string, password: string): boolean;
  /** Set the device's unplugged transport mode (a wire {@link Transport} value). */
  setTransport(mac: string, mode: number): boolean;
  /**
   * Enter/leave ESP-NOW bridge mode on a USB device (runtime-only on the device — re-asserted by
   * the host). Sent only to version ≥ 3 devices by the caller. Returns false when the MAC isn't on USB.
   */
  setBridge(mac: string, enabled: boolean): boolean;
  /** Pull a fresh STATUS from a USB device (e.g. right after it connects). */
  requestStatus(mac: string): boolean;
  on(
    event: "status",
    listener: (status: {
      mac: string;
      mode: number;
      wifiState: DeviceWifiState;
      rssi: number | null;
      ssid: string;
      channel: number | null;
      bridge: boolean;
    }) => void,
  ): unknown;
  on(event: "log", listener: (...args: DeviceTransportEvents["log"]) => void): unknown;
}

/**
 * The seam the orchestrator uses to tell the ESP-NOW transport which bridge MAC to route relayed
 * colours through. Kept narrow so tests fake it in one line; the production
 * {@link EspNowTransport} satisfies it.
 */
export interface EspNowBridgePort {
  /** Point outbound RELAY frames at this bridge MAC (null = no bridge designated). */
  setBridgeMac(mac: string | null): void;
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
  /** MAC of the designated ESP-NOW bridge, or null when none. Persisted (survives restarts). */
  readonly bridgeMac: string | null;
  device(mac: string): DeviceConfig | undefined;
  devices(): Array<[string, DeviceConfig]>;
  setSourceIp(ip: string | null): Promise<void>;
  /** Designate (or clear, with null) the ESP-NOW bridge. */
  setBridgeMac(mac: string | null): Promise<void>;
  assign(mac: string, inputId: number): Promise<void>;
  unassign(mac: string): Promise<void>;
  setBrightness(mac: string, brightness: number): Promise<void>;
  /** Remember (or clear, with null) the SSID a device was provisioned to join over USB. */
  setSsid(mac: string, ssid: string | null): Promise<void>;
  /** Resolve once all queued writes have been flushed to disk. */
  flush(): Promise<void>;
}

export interface IpcPort {
  send(event: SidecarEvent): void;
  notice(level: LogLevelName, message: string): void;
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
 * The locate strobe — the server-driven replacement for the retired device IDENTIFY. When the
 * operator asks to find a light we stream a bright white/off burst (overriding its normal frame)
 * for {@link IDENTIFY_DURATION_MS}, toggling every {@link IDENTIFY_HALF_MS}, then let its real
 * colour resume. Keeping this on the server is the whole point: the firmware stays dumb and only
 * ever renders the colours it's sent.
 */
const IDENTIFY_COLOR: Color = { r: 255, g: 255, b: 255 };
const IDENTIFY_HALF_MS = 150;
const IDENTIFY_DURATION_MS = IDENTIFY_HALF_MS * 6; // three white/off cycles (~0.9 s)

/** Keyframes a light can miss in a row before its link times out (250 ms at 5 s). */
const KEYFRAMES_PER_LINK_TIMEOUT = 20;

/**
 * How often to re-assert every connected device's current colour, regardless of change. Treats
 * SET_COLOR as periodic *state* rather than a one-shot *event*: a packet lost in flight self-heals
 * on the next tick. Reliable transports (TCP, USB-CDC) don't need it for loss, but the cost is
 * trivial (~6 payload bytes × 4/s per device) and it's applied uniformly so the firmware never has
 * to know its transport's reliability. It's the safeguard that makes v1.3's fire-and-forget ESP-NOW path
 * trustworthy — and it lets a light that power-cycles or drifts into range mid-show recover within
 * a tick, without waiting on a reconnect handshake. The keyframe is also every light's proof its
 * host is alive, on every transport: the firmware shows steady blue after 5 s without one
 * ({@link HOST_SILENCE_TIMEOUT_MS}, mirrored in the firmware's `protocol.h`). 250 ms (not 1 s)
 * so that timeout takes {@link KEYFRAMES_PER_LINK_TIMEOUT} consecutive lost keyframes rather than
 * 5 on lossy ESP-NOW, and an ESP-NOW light that did lose the link relinks on the next keyframe to
 * reach it. So the period is derived from that timeout, not set beside it: shortening the
 * firmware's timeout shortens the keyframe with it. Animated devices already re-send
 * every {@link ANIM_TICK_MS}; this keyframe is their redundant-but-harmless backstop and the only
 * resend a steady device gets.
 */
const REFRESH_PERIOD_MS = HOST_SILENCE_TIMEOUT_MS / KEYFRAMES_PER_LINK_TIMEOUT;

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
  /** USB provisioning + diagnostics (the composite server supplies it; see `wiring.ts`). */
  provisioning: ProvisioningPort;
  /**
   * The ESP-NOW transport's bridge-designation seam (the {@link EspNowTransport}, or a no-op
   * when it isn't running). Told which bridge MAC to route relayed colours through.
   */
  espnow: EspNowBridgePort;
  store: StorePort;
  ipc: IpcPort;
  /** Where to log diagnostics (defaults to stderr; stdout is protocol-only). */
  log?: (message: string) => void;
  /** Override the animation timer (tests inject a steppable clock). */
  animClock?: AnimationClock;
  /** Override the animation tick in ms (default {@link ANIM_TICK_MS}); each step advances elapsed time by this. */
  animTickMs?: number;
  /**
   * Override the always-on colour-refresh timer (tests inject a steppable clock; reuses the
   * {@link AnimationClock} seam, but a *separate* instance from {@link animClock} since the two run
   * independently). Drives the {@link REFRESH_PERIOD_MS} keyframe re-send.
   */
  refreshClock?: AnimationClock;
  /** Override the refresh period in ms (default {@link REFRESH_PERIOD_MS}). */
  refreshMs?: number;
  /** The subnet sweep behind the settings "Scan" (injected so tests don't open sockets). */
  scanNetwork: (log: (message: string) => void) => Promise<SourceScanHit[]>;
  /**
   * Mark every snapshot as dev mode (running against the fake ATEM). The UI reads this
   * to make the board's input keys clickable. Set only by the fake-ATEM dev entry;
   * production leaves it false.
   */
  dev?: boolean;
}

/** The fault key for a light's latest WARN/ERROR line (cleared when it reconnects). */
function deviceLogFault(mac: string): string {
  return `device:${mac}:log`;
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
  readonly #provisioning: ProvisioningPort;
  readonly #espnow: EspNowBridgePort;
  readonly #store: StorePort;
  readonly #ipc: IpcPort;
  readonly #log: (message: string) => void;
  readonly #animClock: AnimationClock;
  readonly #animTickMs: number;
  readonly #refreshClock: AnimationClock;
  readonly #refreshMs: number;
  readonly #scanNetwork: (log: (message: string) => void) => Promise<SourceScanHit[]>;
  readonly #dev: boolean;
  /** What the operator must see that only the sidecar knows (`faults.ts`); rides every snapshot. */
  readonly #faults: FaultBook;

  /** True while a subnet sweep is in flight — a second "Scan" is ignored until it ends. */
  #scanning = false;

  /** Connected devices → their reported protocol version (present only while online). */
  readonly #online = new Map<string, number>();
  /**
   * Firmware version each device last reported. Kept across a disconnect, so a reconnect doesn't
   * flash the "outdated" badge in the moment between its HELLO and its FIRMWARE message.
   */
  readonly #firmware = new Map<string, string>();
  /** The last colour pushed to each device, to suppress redundant SET_COLORs. */
  readonly #lastColor = new Map<string, { color: Color; brightness: number }>();
  /** Devices mid locate-strobe → elapsed ms into the burst; cleared when it ends (see {@link IDENTIFY_DURATION_MS}). */
  readonly #identifying = new Map<string, number>();
  /** Latest USB STATUS per device — surfaced for the provisioning wizard (mode + join progress). */
  readonly #usbStatus = new Map<
    string,
    { mode: number; wifiState: DeviceWifiState; rssi: number | null }
  >();
  /**
   * MACs whose latest STATUS confirmed bridge mode (its trailing `bridging` byte). The store holds the *designation*;
   * this is the device-confirmed flag the UI surfaces as `Device.bridge`. Cleared on disconnect.
   */
  readonly #bridgeConfirmed = new Set<string>();

  /** Stops the animation clock, or null when nothing is currently animated. */
  #stopAnim: (() => void) | null = null;
  /** Stops the always-on refresh clock, or null while the app isn't running. */
  #stopRefresh: (() => void) | null = null;
  /** Elapsed animation time (ms); the flash phase and breathe envelope are both derived from it. */
  #animMs = 0;

  #source: SourceSnapshot;
  // The override layer is modelled from v1 but stays inactive until a source wires it.
  readonly #gate = INACTIVE_GATE;

  constructor(deps: SidecarAppDeps) {
    this.#atem = deps.atem;
    this.#server = deps.deviceServer;
    this.#provisioning = deps.provisioning;
    this.#espnow = deps.espnow;
    this.#store = deps.store;
    this.#ipc = deps.ipc;
    this.#log = deps.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.#animClock = deps.animClock ?? realAnimationClock;
    this.#animTickMs = deps.animTickMs ?? ANIM_TICK_MS;
    this.#refreshClock = deps.refreshClock ?? realAnimationClock;
    this.#refreshMs = deps.refreshMs ?? REFRESH_PERIOD_MS;
    this.#scanNetwork = deps.scanNetwork;
    this.#dev = deps.dev ?? false;
    this.#faults = new FaultBook(this.#log);
    this.#source = deps.atem.snapshot();

    this.#ipc.on("command", (command) => void this.#run(command));

    this.#server.on("deviceConnected", ({ mac, version }) => {
      this.#online.set(mac, version);
      // A reconnect is a fresh start: the light's last complaint was about the session before.
      this.#faults.clear(deviceLogFault(mac));
      this.#lastColor.delete(mac); // reconnect may skip the disconnect event; always re-push
      // Pull a fresh STATUS so an already-provisioned device reports its mode/ssid-state at once,
      // rather than waiting for a spontaneous frame (no-op for non-USB devices).
      this.#provisioning.requestStatus(mac);
      // SET_BRIDGE is runtime-only on the device, so the host re-asserts it on every (re)connect of
      // the designated bridge — a replug or reboot re-enters bridge mode without operator action.
      this.#assertBridgeIfDesignated(mac, version);
      this.#log(`device connected: ${mac} (protocol v${version})`);
      this.#sync();
    });
    this.#server.on("deviceDisconnected", ({ mac }) => {
      this.#online.delete(mac);
      this.#lastColor.delete(mac); // forget it, so a reconnect is sent its colour afresh
      this.#usbStatus.delete(mac); // stale once it's gone
      this.#bridgeConfirmed.delete(mac); // device-confirmed bridge flag is stale once it's gone
      this.#log(`device disconnected: ${mac}`);
      this.#sync();
    });
    this.#server.on("deviceUnsupported", ({ mac, version, reason }) => {
      // The stale side is the one to update: a light behind this app gets reflashed, but a light
      // ahead of it (flashed by a newer TallyBot) can only be understood once the app catches up.
      const message =
        reason === "app-too-old"
          ? `Tally ${macTail(mac)} runs newer firmware (protocol v${version}) than this TallyBot; update TallyBot in Settings → About → Updates.`
          : `Tally ${macTail(mac)} runs old firmware (protocol v${version}); update it.`;
      this.#ipc.notice("warn", message);
    });
    this.#server.on("firmware", ({ mac, version }) => {
      if (this.#firmware.get(mac) === version) return;
      this.#firmware.set(mac, version);
      this.#log(`device ${mac} runs firmware ${version}`);
      this.#sync();
    });
    // A light's connection failing (a frame it sent that can't be decoded, a socket or discovery
    // error): one fault, replaced by the next, that the operator can dismiss. Nothing clears it on
    // its own, because nothing reports the transport healthy again.
    this.#server.on("error", (err) =>
      this.#report({
        key: "transport",
        level: "warn",
        message: `A tally light connection reported an error (${err.message}). TallyBot keeps running; a light that stays wrong may need unplugging and plugging back in.`,
      }),
    );

    // USB provisioning + diagnostics.
    this.#provisioning.on("status", ({ mac, mode, wifiState, rssi, ssid, bridge }) => {
      this.#usbStatus.set(mac, { mode, wifiState, rssi });
      // Track the device-confirmed bridge flag so the snapshot's `Device.bridge` reflects the
      // device's own STATUS, not just our designation intent (the two can briefly disagree).
      if (bridge) this.#bridgeConfirmed.add(mac);
      else this.#bridgeConfirmed.delete(mac);
      // The device reports its NVS SSID, so adopt it as the source of truth — this keeps the
      // stored name accurate even for a device this host never provisioned. `""` means no creds
      // (clear any stale entry); only write on a change, since STATUS now streams. setSsid mutates
      // the in-memory config synchronously, so the #sync() below already reflects it.
      const stored = this.#store.device(mac)?.ssid ?? "";
      if (ssid !== stored) void this.#save(this.#store.setSsid(mac, ssid === "" ? null : ssid));
      this.#sync(); // the wizard reads mode/wifiState/rssi off the snapshot
    });
    // A light's WARN/ERROR lines (its own LOG frames, relayed ones such as an ESP-NOW relink gap,
    // and a transport's notes on it such as a TCP expiry) are a per-light fault holding the latest
    // line, so the operator sees an outage the light itself noticed. INFO stays in the log file.
    this.#provisioning.on("log", ({ mac, level, text }) => {
      this.#ipc.send({ type: "deviceLog", mac, level, text });
      if (level === "info") return;
      this.#report({ key: deviceLogFault(mac), level, mac, message: `Light ${macTail(mac)}: ${text.trim()}` });
    });

    this.#atem.on("change", (snapshot) => {
      this.#source = snapshot;
      // A source that answers, or one the operator stopped wanting, has no connect fault left.
      if (snapshot.connection !== "connecting") this.#faults.clear("atem");
      this.#sync();
    });
    // While connecting, an error is the reason it isn't connecting, and the operator needs it (a
    // refused or unreachable address reads very differently from a wrong IP). Once connected the
    // library recovers on its own and tally is still flowing, so a mid-session error is logged only.
    this.#atem.on("error", (err) => {
      const { connection, ip } = this.#source;
      if (connection === "connected" || ip === null) {
        this.#log(`ATEM error: ${err.message}`);
        return;
      }
      this.#report({
        key: "atem",
        level: "warn",
        message: `Can't connect to the ATEM at ${ip}: ${err.message}. Check the IP address, and that this PC is on the same network as the switcher.`,
      });
    });
  }

  /** Start the device server and connect to the saved ATEM, then emit a first snapshot. */
  async start(): Promise<void> {
    await this.#server.start();
    const ip = this.#store.sourceIp;
    if (ip) this.#atem.connect(ip); // emits a `change` that will publish; #sync below covers the no-ip case
    // Route relayed colours to the persisted bridge MAC from the off (re-asserting SET_BRIDGE waits
    // for the device to (re)connect over USB, handled in the deviceConnected listener).
    this.#espnow.setBridgeMac(this.#store.bridgeMac);
    this.#sync();
    // Begin the periodic keyframe re-send (runs for the app's whole life — see REFRESH_PERIOD_MS).
    this.#stopRefresh = this.#refreshClock.start(this.#refreshMs, () => this.#refresh());
  }

  /** Shut down cleanly: stop the animation clock, the server, the ATEM, flush pending writes. */
  async stop(): Promise<void> {
    this.#setAnimating(false);
    this.#stopRefresh?.();
    this.#stopRefresh = null;
    this.#ipc.close();
    await this.#atem.disconnect();
    await this.#server.stop();
    await this.#store.flush();
  }

  // ── Commands from the UI ─────────────────────────────────────────────────────

  /**
   * Handle one command, so that whatever it throws is told to the operator and logged, never left
   * to reject: an unhandled rejection is fatal, and one bad command must not stop the engine
   * mid-show. Never rejects.
   */
  async #run(command: UiCommand): Promise<void> {
    try {
      await this.#handleCommand(command);
    } catch (err) {
      this.#log(`command ${command.type} failed: ${(err as Error).stack ?? describeError(err)}`);
      this.#ipc.notice("error", `TallyBot couldn't do that (${command.type}: ${describeError(err)}). Try again; if it keeps failing, restart the engine in Settings.`);
    }
  }

  /**
   * Wait for a config write and report how it went: a failed one raises the `state.write` fault,
   * the next one that lands clears it (each write is the whole config, so it saves what the failed
   * one lost). The change itself already took effect in memory, so the caller carries on either
   * way, which is why this never rejects.
   */
  async #save(write: Promise<void>): Promise<void> {
    try {
      await write;
    } catch (err) {
      this.#report({
        key: "state.write",
        level: "error",
        message: `TallyBot couldn't save its settings (${describeError(err)}). Changes work for now, but are lost if TallyBot restarts before a save succeeds.`,
        cause: err,
      });
      return;
    }
    if (this.#faults.clear("state.write")) this.#sync();
  }

  async #handleCommand(command: UiCommand): Promise<void> {
    switch (command.type) {
      case "assignDevice":
        await this.#save(this.#store.assign(command.mac, command.inputId));
        this.#sync();
        break;
      case "unassignDevice":
        await this.#save(this.#store.unassign(command.mac));
        this.#sync();
        break;
      case "identifyDevice":
        if (this.#online.has(command.mac)) this.#startIdentify(command.mac);
        else this.#ipc.notice("info", `Tally ${macTail(command.mac, 2)} is offline — can't flash it.`);
        break;
      case "setBrightness":
        await this.#save(this.#store.setBrightness(command.mac, command.brightness));
        this.#sync();
        break;
      case "setSource":
        if (!isIPv4(command.ip)) {
          this.#ipc.notice("info", `"${command.ip}" isn't an IPv4 address — can't connect to it.`);
          break;
        }
        await this.#save(this.#store.setSourceIp(command.ip));
        this.#faults.clear("atem"); // a new attempt; its own errors will say if it fails too
        this.#atem.connect(command.ip); // change event publishes the new connecting state
        break;
      case "provisionWifi": {
        // The light would silently drop credentials over its limits, and the SSID would be stored
        // as if it took: refuse here, with the reason.
        const problem = wifiCredentialsProblem(command.ssid, command.password);
        if (problem) {
          this.#ipc.notice("warn", `Can't set up Wi-Fi on tally ${macTail(command.mac, 2)}: ${problem}`);
          break;
        }
        if (this.#provisioning.provisionWifi(command.mac, command.ssid, command.password)) {
          // Record the attempted SSID immediately so the wizard shows it without waiting for the
          // device's confirming STATUS. (That STATUS now echoes the NVS SSID too and reconciles to
          // the same value.) A failed join still renders its own `failed` view, and the stored SSID
          // pre-fills the retry form.
          await this.#save(this.#store.setSsid(command.mac, command.ssid));
          this.#sync();
        } else {
          this.#ipc.notice("info", `Tally ${macTail(command.mac, 2)} isn't on USB — can't provision WiFi.`);
        }
        break;
      }
      case "setTransport": {
        // The sidecar's backstop for the UI's ESP-NOW gate: never send SET_TRANSPORT(ESPNOW) to a
        // light whose firmware predates it. (An unknown version means it isn't connected, which
        // the USB send below already refuses.)
        const version = this.#online.get(command.mac);
        if (command.mode === "espnow" && version !== undefined && !supportsEspNow(version)) {
          this.#ipc.notice("info", `Tally ${macTail(command.mac, 2)} runs firmware too old for ESP-NOW — can't switch it.`);
          break;
        }
        if (this.#provisioning.setTransport(command.mac, transportModeValue(command.mode))) {
          // No-TX has no network — drop any remembered SSID so a re-plug doesn't show a stale one.
          if (command.mode === "notx") await this.#save(this.#store.setSsid(command.mac, null));
          this.#sync();
        } else {
          this.#ipc.notice("info", `Tally ${macTail(command.mac, 2)} isn't on USB — can't set its transport.`);
        }
        break;
      }
      case "setBridge":
        await this.#designateBridge(command.mac);
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
   * Apply a new bridge designation (or clear it, with null): persist it, leave the previous
   * designee's bridge mode (SET_BRIDGE 0) and enter the new one's (SET_BRIDGE 1) where each is
   * USB-connected and new enough, and point the ESP-NOW transport's relay routing at the new MAC.
   * Designating a new MAC replaces the old — one bridge per session (v1.3 spec).
   */
  async #designateBridge(mac: string | null): Promise<void> {
    const previous = this.#store.bridgeMac;
    if (previous === mac) {
      // Idempotent re-designation: still re-assert (the runtime flag may have been lost) and sync.
      if (mac !== null) this.#assertBridgeIfDesignated(mac, this.#online.get(mac));
      this.#sync();
      return;
    }
    await this.#save(this.#store.setBridgeMac(mac));
    // Stand the old bridge down so two devices never both relay (only matters while it's cabled).
    if (previous !== null) {
      this.#bridgeConfirmed.delete(previous);
      this.#sendBridge(previous, false, this.#online.get(previous));
    }
    // Bring the new one up, and route relayed colours through it from now on.
    if (mac !== null) this.#sendBridge(mac, true, this.#online.get(mac));
    this.#espnow.setBridgeMac(mac);
    this.#sync();
  }

  /** Re-assert SET_BRIDGE 1 if `mac` is the designated bridge — used on every (re)connect. */
  #assertBridgeIfDesignated(mac: string, version: number | undefined): void {
    if (this.#store.bridgeMac === mac) this.#sendBridge(mac, true, version);
  }

  /**
   * Send SET_BRIDGE to a device, but only when it's USB-connected and its version
   * {@link supportsEspNow}. A no-op otherwise — an offline or old device simply can't be a
   * bridge, and the designation is re-asserted when it next connects with a new-enough version.
   */
  #sendBridge(mac: string, enabled: boolean, version: number | undefined): void {
    if (version === undefined || !supportsEspNow(version)) return;
    this.#provisioning.setBridge(mac, enabled);
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
      const online = this.#online.has(mac);
      const status = this.#usbStatus.get(mac);
      records.push({
        mac,
        macTail: macTail(mac),
        online,
        protocolVersion: this.#online.get(mac) ?? null,
        firmware: this.#firmwareOf(mac),
        inputId: config?.inputId ?? null,
        brightness: config?.brightness ?? DEFAULT_BRIGHTNESS,
        // Offline/unknown devices default to WiFi; the indicator only flips to "usb" while cabled.
        transport: (online ? this.#provisioning.transportOf(mac) : null) ?? "wifi",
        wifiState: status?.wifiState ?? null,
        rssi: status?.rssi ?? null,
        // Mode comes from the live USB STATUS (null off-USB); the SSID is the host's memory
        // (the device never echoes the string), so it survives across transports/restarts.
        provisionedMode: status ? provisionedModeName(status.mode) : null,
        ssid: config?.ssid ?? null,
        // The device is the bridge only while it's the designated MAC *and* its STATUS confirms
        // bridge mode (a designation we can't yet confirm — offline, or mid-handshake — reads false).
        bridge: mac === this.#store.bridgeMac && this.#bridgeConfirmed.has(mac),
      });
    }
    return records;
  }

  /**
   * The one place a device's {@link DeviceFirmware} is decided. A reported version wins (and
   * outlives a disconnect, see {@link #firmware}); a device that is connected — so has sent its
   * HELLO — without one runs firmware that predates FIRMWARE; anything else hasn't been heard from.
   */
  #firmwareOf(mac: string): DeviceFirmware {
    const version = this.#firmware.get(mac);
    if (version !== undefined) return { kind: "reported", version };
    return this.#online.has(mac) ? { kind: "legacy" } : { kind: "unknown" };
  }

  #sync(): void {
    const { state, colors } = computeEngine(this.#source, this.#gate, this.#deviceRecords());
    this.#applyColors(colors);
    const faults = this.#faults.list();
    this.#ipc.send({ type: "state", state: { ...state, faults, ...(this.#dev ? { dev: true } : {}) } });
  }

  // ── Faults ─────────────────────────────────────────────────────────────────────

  /** Raise (or replace) a fault: logged always, published when it changed (see {@link FaultBook}). */
  #report(report: FaultReport): void {
    if (this.#faults.raise(report)) this.#sync();
  }

  /**
   * Push each device's target frame (resolving the current animation phase for flashing /
   * breathing ones from {@link #animMs}) and arm or disarm the animation clock to match. Called
   * on every real change and on every animation tick; the diff in {@link #pushColor} keeps a
   * steady rig quiet — only animated devices re-send.
   */
  #applyColors(colors: ReadonlyArray<DeviceColor>, force = false): void {
    // A locate strobe keeps the clock armed for its whole duration even when no engine
    // animation is active, so the burst ticks to completion on a steady rig too.
    let anyAnimated = this.#identifying.size > 0;
    for (const target of colors) {
      // The locate strobe overrides the device's normal frame for its whole duration, so a
      // live (streamed) tally colour can't drown out the flash — the server, not the device,
      // decides every frame.
      const idElapsed = this.#identifying.get(target.mac);
      if (idElapsed !== undefined) {
        const lit = Math.floor(idElapsed / IDENTIFY_HALF_MS) % 2 === 0;
        this.#pushColor(
          lit
            ? { mac: target.mac, color: IDENTIFY_COLOR, brightness: DEFAULT_BRIGHTNESS }
            : { mac: target.mac, color: FLASH_OFF, brightness: 0 },
          force,
        );
        continue;
      }
      switch (target.anim) {
        case "flash": {
          anyAnimated = true;
          // Lit for the first half of each cycle, dark for the second — the ~1 Hz fault flash.
          const lit = Math.floor(this.#animMs / FLASH_HALF_MS) % 2 === 0;
          this.#pushColor({ mac: target.mac, color: lit ? target.color : FLASH_OFF, brightness: target.brightness }, force);
          break;
        }
        case "breathe": {
          anyAnimated = true;
          // Colour held; brightness swells in a slow sine — the unassigned "alive, waiting" state.
          const brightness = breatheBrightness(this.#animMs, target.brightness);
          this.#pushColor({ mac: target.mac, color: target.color, brightness }, force);
          break;
        }
        default:
          this.#pushColor({ mac: target.mac, color: target.color, brightness: target.brightness }, force);
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
    // Advance each locate strobe; when one finishes, forget it and drop its last colour so the
    // device's real frame is re-pushed (not suppressed by the diff) on the applyColors below.
    for (const [mac, elapsed] of this.#identifying) {
      const next = elapsed + this.#animTickMs;
      if (next >= IDENTIFY_DURATION_MS) {
        this.#identifying.delete(mac);
        this.#lastColor.delete(mac);
      } else {
        this.#identifying.set(mac, next);
      }
    }
    const { colors } = computeEngine(this.#source, this.#gate, this.#deviceRecords());
    this.#applyColors(colors);
  }

  /**
   * Begin the locate strobe for one device (the server-driven replacement for the retired
   * device IDENTIFY). Streams a white/off SET_COLOR burst that overrides the device's normal
   * frame; {@link #applyColors} arms the animation clock and {@link #tickAnim} runs it to
   * completion, after which the real colour resumes.
   */
  #startIdentify(mac: string): void {
    this.#identifying.set(mac, 0);
    const { colors } = computeEngine(this.#source, this.#gate, this.#deviceRecords());
    this.#applyColors(colors); // first lit frame now; #setAnimating arms the clock
  }

  /**
   * Periodic keyframe: re-assert every connected device's current colour, bypassing the
   * {@link #pushColor} diff so a packet lost in flight is corrected on the next tick (see
   * {@link REFRESH_PERIOD_MS}). Recomputes from live state so it always re-sends the *current*
   * frame, never a stale one. No-op (and no recompute) when nothing is connected.
   */
  #refresh(): void {
    if (this.#online.size === 0) return;
    const { colors } = computeEngine(this.#source, this.#gate, this.#deviceRecords());
    this.#applyColors(colors, true);
  }

  /**
   * Send SET_COLOR when the device's target colour changed — or unconditionally when `force` is
   * set (the periodic keyframe re-send). Either way, only a successful send updates {@link #lastColor}.
   */
  #pushColor(target: { mac: string; color: Color; brightness: number }, force = false): void {
    const last = this.#lastColor.get(target.mac);
    if (!force && last && colorsEqual(last, target)) return;
    if (this.#server.sendColor(target.mac, target.color, target.brightness)) {
      this.#lastColor.set(target.mac, { color: target.color, brightness: target.brightness });
    }
  }
}

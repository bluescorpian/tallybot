/**
 * The tally engine — the **pure** heart of the sidecar.
 *
 * It takes everything the sidecar knows (what the source reports, the program
 * gate, and each device's runtime + persisted facts) and derives two things in one
 * pass:
 *
 *   1. the `AppState` snapshot the UI renders (`src/ipc.ts`), and
 *   2. the LED colour every online device should be showing.
 *
 * Both fall out of the same inputs, so deriving them together keeps all the tally
 * logic in one place. The function has no side effects and touches no sockets or
 * disk — the orchestrator (`src/app.ts`) feeds it state and acts on the result —
 * which is what makes it exhaustively unit-testable (`engine.test.ts`).
 *
 * The pipeline mirrors docs/goals.md ("source → per-input program/preview →
 * override(s) → per-device colour").
 */

import type {
  AppState,
  Device,
  DeviceFirmware,
  DeviceTransport,
  DeviceWifiState,
  Input,
  ProgramGate,
  SourceConnection,
  Tally,
  TransportMode,
} from "./ipc.ts";
import { type Color, COLORS, DEFAULT_BRIGHTNESS, SETUP_COLOR } from "./protocol.ts";

// ── Inputs the engine derives from ──────────────────────────────────────────────

/** What the source (the ATEM) currently reports, normalised by the ATEM adapter. */
export interface SourceSnapshot {
  /** The configured ATEM IP, or null until the user sets one. */
  ip: string | null;
  connection: SourceConnection;
  /** Input on program output, or null when unknown (e.g. not connected). */
  programInput: number | null;
  /** Input on preview, or null when unknown. */
  previewInput: number | null;
  /** The mix (AUTO or T-bar transition) in progress, or null/absent when none is. */
  transition?: Transition | null;
  /** The source's camera inputs and their labels, in display order. */
  inputs: ReadonlyArray<{ id: number; label: string }>;
}

/**
 * A mix in progress. `programInput` is the outgoing source throughout; `previewInput` has
 * already moved on to the source queued for after the mix, so the incoming one is held here.
 */
export interface Transition {
  /** The source being mixed onto program. */
  incomingInput: number;
  /** How far the mix has travelled, 0 (all outgoing) to 1 (all incoming). */
  progress: number;
}

/**
 * Everything the orchestrator knows about one device: its live connection facts
 * (from the TCP server) merged with its persisted assignment (from the store).
 */
export interface DeviceRecord {
  /** Full MAC, lower-case colon form — the device's identity. */
  mac: string;
  /** Short MAC tail shown in the UI. */
  macTail: string;
  /** True when the device currently has an open connection to the server. */
  online: boolean;
  /** Protocol version from the device's most recent HELLO, or null if never seen. */
  protocolVersion: number | null;
  /**
   * What firmware the device runs, as the orchestrator decides it. Optional so pure-engine record
   * literals need no change (absent reads as `unknown`); the orchestrator always supplies it.
   */
  firmware?: DeviceFirmware;
  /** The input this device is assigned to, or null when unassigned. */
  inputId: number | null;
  /** Per-device LED brightness, 0–255. */
  brightness: number;
  /** Transport currently serving the device (drives the wired indicator). */
  transport: DeviceTransport;
  /** WiFi join progress while provisioning over USB; null when not applicable. */
  wifiState: DeviceWifiState | null;
  /** Last reported RSSI (dBm) while provisioning over USB; null when not applicable. */
  rssi: number | null;
  /**
   * Persisted "when unplugged" behaviour the device reports over USB (`"wifi"`/`"notx"`),
   * or null when never provisioned / not on USB. Optional so existing record literals (and the
   * pure-engine tests) need no change; the orchestrator always supplies it.
   */
  provisionedMode?: TransportMode | null;
  /** SSID the device is provisioned to join when unplugged, or null. Optional (see above). */
  ssid?: string | null;
  /**
   * True while this device is the designated ESP-NOW bridge *and* has confirmed bridge mode via
   * its STATUS `bridging` byte. Designation lives in the store; this is the device-confirmed state the
   * UI shows. Optional so pure-engine record literals need no change.
   */
  bridge?: boolean;
}

/**
 * How the orchestrator animates a device's colour. The pure engine has no clock, so it
 * only *names* the animation; `src/app.ts` drives it from a timer:
 *   - `none`    — steady `color`.
 *   - `flash`   — fault: `color` is the lit phase, pulsed against off (~1 Hz).
 *   - `breathe` — unassigned: `color` held while its brightness swells in a slow sine.
 * The firmware stays lean and renders whatever frame it's sent — all connected-state motion
 * lives here (docs/led.md).
 */
export type Anim = "none" | "flash" | "breathe";

/** The colour an online device should display. Offline devices yield no command. */
export interface DeviceColor {
  mac: string;
  color: Color;
  brightness: number;
  anim: Anim;
}

export interface EngineResult {
  /** The snapshot to emit to the UI. */
  state: AppState;
  /** Target LED colour for every *online* device (offline devices are omitted). */
  colors: DeviceColor[];
}

// ── Derivations ──────────────────────────────────────────────────────────────────

/**
 * The tally for one input.
 *
 * 1. The program gate wins first: an active override (e.g. OBS off the ATEM scene)
 *    is a *known, deliberate* "no program" state, so every input reads idle.
 * 2. Otherwise, if we can't trust the source, the input is `unknown` (the fault
 *    state). This is the safety-critical case: a disconnected or reconnecting ATEM —
 *    or a connected one that hasn't reported its program input yet — means we have no
 *    idea what's actually live, so we must NOT report a confident idle (green reads as
 *    "you're clear"). `unknown` becomes a flashing-blue fault on the device, distinct
 *    from both a real idle and the device-local steady-blue "I lost the server"
 *    (docs/architecture.md "Failure signalling"). We rely on `atem-connection`'s own
 *    keepalive to turn a silently-dead link into a disconnect, rather than guessing
 *    staleness from the gap between state changes — a quiet but healthy switcher can
 *    legitimately send nothing for minutes.
 * 3. With a trustworthy source, the input is live/preview/idle as usual. Mid-mix both the
 *    outgoing and the incoming source are on air, so both read live.
 */
export function tallyFor(source: SourceSnapshot, gate: ProgramGate, inputId: number): Tally {
  if (gate.active) return "idle";
  if (source.connection !== "connected" || source.programInput === null) return "unknown";
  if (inputId === source.programInput) return "live";
  if (inputId === source.transition?.incomingInput) return "live";
  if (inputId === source.previewInput) return "preview";
  return "idle";
}

/** Map a device record's connection + assignment to its UI device state. */
function deviceStateOf(device: DeviceRecord): Device["state"] {
  if (!device.online) return "offline";
  return device.inputId === null ? "unassigned" : "assigned";
}

/**
 * The colour an online device should show, and how it animates. An unassigned device
 * gets the white setup colour and *breathes* it (visibly alive, clearly needs configuring
 * — docs/goals.md decision 5; docs/led.md state 5). An assigned device shows its input's tally;
 * the fault (`unknown`) state flashes blue rather than ever resting on green.
 */
function colorFor(
  device: DeviceRecord,
  source: SourceSnapshot,
  gate: ProgramGate,
): { color: Color; anim: Anim } {
  if (device.inputId === null) return { color: SETUP_COLOR, anim: "breathe" };
  const tally = tallyFor(source, gate, device.inputId);
  // Fault: the server flashes blue so the light is an obvious "don't trust me", not a
  // confident idle. Same hue as the device's own disconnected-blue, but flashed — and
  // the device only rests on steady blue when it has lost the server entirely.
  if (tally === "unknown") return { color: COLORS.disconnected, anim: "flash" };
  if (tally === "live") return { color: mixColor(source, device.inputId) ?? COLORS.live, anim: "none" };
  return { color: COLORS[tally], anim: "none" };
}

/**
 * Mid-mix, a live source's light crossfades in step with the picture: the incoming one from
 * preview to live, the outgoing one from live to the colour it settles on once the mix ends.
 * The ATEM reports the mix position at its frame rate and each report re-derives this, so the
 * fade is streamed frame by frame like the other server-driven motion (docs/led.md). Null when
 * the input isn't part of a mix.
 */
function mixColor(source: SourceSnapshot, inputId: number): Color | null {
  const mix = source.transition;
  // Mixing a source onto itself changes nothing on air.
  if (!mix || mix.incomingInput === source.programInput) return null;
  if (inputId === mix.incomingInput) return lerpColor(COLORS.preview, COLORS.live, mix.progress);
  const after = inputId === source.previewInput ? COLORS.preview : COLORS.idle;
  return lerpColor(COLORS.live, after, mix.progress);
}

/** Straight per-channel RGB blend from `from` (t = 0) to `to` (t = 1). */
function lerpColor(from: Color, to: Color, t: number): Color {
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * t);
  return { r: mix(from.r, to.r), g: mix(from.g, to.g), b: mix(from.b, to.b) };
}

/**
 * Derive the UI snapshot and the per-device target colours from the current state.
 * Pure: same inputs always yield the same result, with no I/O.
 */
export function computeEngine(
  source: SourceSnapshot,
  gate: ProgramGate,
  devices: ReadonlyArray<DeviceRecord>,
): EngineResult {
  const inputs: Input[] = source.inputs.map((input) => ({
    id: input.id,
    label: input.label,
    tally: tallyFor(source, gate, input.id),
  }));

  const uiDevices: Device[] = [];
  const colors: DeviceColor[] = [];
  for (const device of devices) {
    uiDevices.push({
      mac: device.mac,
      macTail: device.macTail,
      state: deviceStateOf(device),
      inputId: device.inputId,
      brightness: device.brightness,
      protocolVersion: device.protocolVersion,
      firmware: device.firmware ?? { kind: "unknown" },
      transport: device.transport,
      wifiState: device.wifiState,
      rssi: device.rssi,
      provisionedMode: device.provisionedMode ?? null,
      ssid: device.ssid ?? null,
      bridge: device.bridge ?? false,
    });
    if (device.online) {
      const { color, anim } = colorFor(device, source, gate);
      colors.push({ mac: device.mac, color, brightness: device.brightness, anim });
    }
  }

  const state: AppState = {
    source: { kind: "atem", ip: source.ip, connection: source.connection },
    inputs,
    devices: uiDevices,
    programGate: gate,
  };
  return { state, colors };
}

/** The program gate in its v1 resting state: present but inactive (docs/goals.md). */
export const INACTIVE_GATE: ProgramGate = { active: false, source: null };

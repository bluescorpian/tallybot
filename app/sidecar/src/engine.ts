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
 * The pipeline mirrors `GOALS.md` ("source → per-input program/preview →
 * override(s) → per-device colour").
 */

import type {
  AppState,
  Device,
  DeviceTransport,
  DeviceWifiState,
  Input,
  ProgramGate,
  SourceConnection,
  Tally,
} from "./ipc.ts";
import { type Color, COLORS, DEFAULT_BRIGHTNESS, PROTOCOL_VERSION, SETUP_COLOR } from "./protocol.ts";

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
  /** The source's camera inputs and their labels, in display order. */
  inputs: ReadonlyArray<{ id: number; label: string }>;
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
 *    (ARCHITECTURE.md "Failure signalling"). We rely on `atem-connection`'s own
 *    keepalive to turn a silently-dead link into a disconnect, rather than guessing
 *    staleness from the gap between state changes — a quiet but healthy switcher can
 *    legitimately send nothing for minutes.
 * 3. With a trustworthy source, the input is live/preview/idle as usual.
 */
export function tallyFor(source: SourceSnapshot, gate: ProgramGate, inputId: number): Tally {
  if (gate.active) return "idle";
  if (source.connection !== "connected" || source.programInput === null) return "unknown";
  if (inputId === source.programInput) return "live";
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
 * — GOALS.md decision 5; docs/led.md state 5). An assigned device shows its input's tally;
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
  return { color: COLORS[tally], anim: "none" };
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
      firmwareOutdated:
        device.protocolVersion !== null && device.protocolVersion < PROTOCOL_VERSION.MIN_SUPPORTED,
      transport: device.transport,
      wifiState: device.wifiState,
      rssi: device.rssi,
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

/** The program gate in its v1 resting state: present but inactive (GOALS.md). */
export const INACTIVE_GATE: ProgramGate = { active: false, source: null };

/** A device's default per-device brightness before the user changes it. */
export { DEFAULT_BRIGHTNESS };

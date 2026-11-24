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
  /**
   * One entry per mix effect the switcher has, indexed as the ATEM numbers them (0 is "ME 1").
   * The length is the switcher's ME count: an ATEM Mini reports one, a 2 M/E two. Empty until the
   * source has reported. Retained across a disconnect, like `inputs`.
   */
  mixEffects: ReadonlyArray<MixEffectSnapshot>;
  /** The source's camera inputs and their labels, in display order. */
  inputs: ReadonlyArray<{ id: number; label: string }>;
}

/** One mix effect's buses: its own Program, Preview and the mix in progress on it. */
export interface MixEffectSnapshot {
  /** Input on this ME's program bus, or null when unknown (not yet reported). */
  programInput: number | null;
  /** Input on this ME's preview bus, or null when unknown. */
  previewInput: number | null;
  /** The mix (AUTO or T-bar transition) in progress on this ME, or null/absent when none is. */
  transition?: Transition | null;
}

/**
 * The MEs a device follows when it has no setting of its own: ME 1 only, the one bus an ATEM Mini
 * has, so a single-ME rig needs no configuration.
 */
export const DEFAULT_MIX_EFFECTS: readonly number[] = [0];

/**
 * Upper bound on an ME index the sidecar accepts. Not a switcher limit (the ME count comes from
 * the switcher itself); it only keeps a hand-edited or garbled list from being taken seriously.
 */
const MAX_MIX_EFFECT_INDEX = 15;

/**
 * A followed-ME list in its canonical form (sorted, unique, non-empty, each index 0–15), or null
 * when `value` isn't one. Shared by the store (loading the file) and the orchestrator (the UI
 * command), so both accept exactly the same lists.
 */
export function normalizeMixEffects(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const isIndex = (i: unknown): i is number =>
    typeof i === "number" && Number.isInteger(i) && i >= 0 && i <= MAX_MIX_EFFECT_INDEX;
  if (!value.every(isIndex)) return null;
  return [...new Set(value as number[])].sort((a, b) => a - b);
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
  /**
   * The MEs (0-based) whose buses this device's tally follows. Optional so pure-engine record
   * literals need no change: absent reads as {@link DEFAULT_MIX_EFFECTS}.
   */
  mixEffects?: readonly number[];
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
  /** The ESP-NOW channel the device's STATUS reports while cabled, or null. Optional (see above). */
  espnowChannel?: number | null;
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
  /** The snapshot to emit to the UI, less the faults the orchestrator owns and adds. */
  state: Omit<AppState, "faults" | "espnow">;
  /** Target LED colour for every *online* device (offline devices are omitted). */
  colors: DeviceColor[];
}

// ── Derivations ──────────────────────────────────────────────────────────────────

/** Ranks a tally for combining MEs: the higher one wins (see {@link tallyFor}). */
const TALLY_RANK: Record<Tally, number> = { live: 3, unknown: 2, preview: 1, idle: 0 };

/**
 * The tally for one input, across the MEs `mixEffects` names (default: ME 1 only).
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
 * 3. With a trustworthy source, each followed ME gives live/preview/idle as usual (mid-mix both
 *    the outgoing and the incoming source are on air, so both read live), and the highest wins:
 *    **Live > Preview > Idle** (docs/architecture.md, "Multi-ME"). A followed ME that hasn't
 *    reported its program input is `unknown`, ranked just below live: the input may be on air
 *    there, so the light can't claim preview or idle, but a live ME elsewhere is already certain.
 *    An ME the switcher doesn't have is skipped (it carries nothing); an input following none
 *    the switcher has is `unknown`, so a light set up for a bigger switcher flashes rather than
 *    resting on a confident idle.
 */
export function tallyFor(
  source: SourceSnapshot,
  gate: ProgramGate,
  inputId: number,
  mixEffects: readonly number[] = DEFAULT_MIX_EFFECTS,
): Tally {
  return followedTally(source, gate, inputId, mixEffects).tally;
}

/** {@link tallyFor}, plus the ME whose state decided it (null when no single ME did). */
function followedTally(
  source: SourceSnapshot,
  gate: ProgramGate,
  inputId: number,
  mixEffects: readonly number[],
): { tally: Tally; me: MixEffectSnapshot | null } {
  if (gate.active) return { tally: "idle", me: null };
  if (source.connection !== "connected") return { tally: "unknown", me: null };
  let best: { tally: Tally; me: MixEffectSnapshot } | null = null;
  for (const index of mixEffects) {
    const me = source.mixEffects[index];
    if (!me) continue;
    const tally = meTally(me, inputId);
    if (best === null || TALLY_RANK[tally] > TALLY_RANK[best.tally]) {
      best = { tally, me };
    } else if (tally === "live" && best.tally === "live" && mixColor(best.me, inputId) && !mixColor(me, inputId)) {
      // Live on two MEs: a steady live beats one mid-mix, so the light holds red rather than
      // crossfading away from a bus it's still on.
      best = { tally, me };
    }
  }
  return best ?? { tally: "unknown", me: null };
}

/** One ME's tally for an input, given a connected source and an open gate. */
function meTally(me: MixEffectSnapshot, inputId: number): Tally {
  if (me.programInput === null) return "unknown";
  if (inputId === me.programInput) return "live";
  if (inputId === me.transition?.incomingInput) return "live";
  if (inputId === me.previewInput) return "preview";
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
  const { tally, me } = followedTally(source, gate, device.inputId, device.mixEffects ?? DEFAULT_MIX_EFFECTS);
  // Fault: the server flashes blue so the light is an obvious "don't trust me", not a
  // confident idle. Same hue as the device's own disconnected-blue, but flashed — and
  // the device only rests on steady blue when it has lost the server entirely.
  if (tally === "unknown") return { color: COLORS.disconnected, anim: "flash" };
  if (tally === "live") return { color: (me && mixColor(me, device.inputId)) ?? COLORS.live, anim: "none" };
  return { color: COLORS[tally], anim: "none" };
}

/**
 * Mid-mix, a live source's light crossfades in step with the picture: the incoming one from
 * preview to live, the outgoing one from live to the colour it settles on once the mix ends.
 * The ATEM reports the mix position at its frame rate and each report re-derives this, so the
 * fade is streamed frame by frame like the other server-driven motion (docs/led.md). Null when
 * the input isn't part of a mix on this ME.
 */
function mixColor(me: MixEffectSnapshot, inputId: number): Color | null {
  const mix = me.transition;
  // Mixing a source onto itself changes nothing on air.
  if (!mix || mix.incomingInput === me.programInput) return null;
  if (inputId === mix.incomingInput) return lerpColor(COLORS.preview, COLORS.live, mix.progress);
  if (inputId !== me.programInput) return null;
  const after = inputId === me.previewInput ? COLORS.preview : COLORS.idle;
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
  // An input's own tally is ME 1's: the board's keys are that bus's button strip. A light's tally
  // follows its own MEs, so it is derived per device below.
  const inputs: Input[] = source.inputs.map((input) => ({
    id: input.id,
    label: input.label,
    tally: tallyFor(source, gate, input.id),
  }));

  const uiDevices: Device[] = [];
  const colors: DeviceColor[] = [];
  for (const device of devices) {
    const mixEffects = device.mixEffects ?? DEFAULT_MIX_EFFECTS;
    uiDevices.push({
      mac: device.mac,
      macTail: device.macTail,
      state: deviceStateOf(device),
      inputId: device.inputId,
      mixEffects: [...mixEffects],
      tally: device.inputId === null ? null : tallyFor(source, gate, device.inputId, mixEffects),
      brightness: device.brightness,
      protocolVersion: device.protocolVersion,
      firmware: device.firmware ?? { kind: "unknown" },
      transport: device.transport,
      wifiState: device.wifiState,
      rssi: device.rssi,
      provisionedMode: device.provisionedMode ?? null,
      ssid: device.ssid ?? null,
      bridge: device.bridge ?? false,
      espnowChannel: device.espnowChannel ?? null,
    });
    if (device.online) {
      const { color, anim } = colorFor(device, source, gate);
      colors.push({ mac: device.mac, color, brightness: device.brightness, anim });
    }
  }

  const state: EngineResult["state"] = {
    source: { kind: "atem", ip: source.ip, connection: source.connection, mixEffectCount: source.mixEffects.length },
    inputs,
    devices: uiDevices,
    programGate: gate,
  };
  return { state, colors };
}

/** The program gate in its v1 resting state: present but inactive (docs/goals.md). */
export const INACTIVE_GATE: ProgramGate = { active: false, source: null };

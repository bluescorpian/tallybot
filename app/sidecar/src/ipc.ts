/**
 * The IPC contract between the Svelte UI and the sidecar.
 *
 * Transport: newline-delimited JSON over the sidecar's stdio. The Tauri shell
 * spawns the sidecar (see the Node-sidecar pattern in `../README.md`), reads its
 * stdout line-by-line and forwards each as a `SidecarEvent` to the webview, and
 * writes `UiCommand`s to its stdin. Both endpoints are TypeScript, so this file
 * is the single shared *type* contract; the UI imports it type-only via the
 * `$ipc` alias (`../svelte.config.js`), so none of it reaches the browser bundle.
 *
 * The nouns mirror docs/goals.md ("Core concepts") on purpose — source, input,
 * device, program-gate — so the schema, persisted state, and UI all line up.
 */

import type { LogLevelName } from "./protocol.ts";

// ── Domain ──────────────────────────────────────────────────────────────────

/**
 * Per-input tally state, derived from the source. `unknown` is the **fault** state:
 * the sidecar can't trust the source (the ATEM is disconnected/reconnecting, or it's
 * connected but hasn't reported a program input), so it must NOT claim a confident
 * `idle` ("you're clear"). A device on an `unknown` input is shown a flashing-blue
 * fault, never green — see `docs/architecture.md` "Failure signalling".
 */
export type Tally = "live" | "preview" | "idle" | "unknown";

export type SourceConnection = "connected" | "connecting" | "disconnected";

/**
 * What produces inputs and reports which are live/preview. v1 hardcodes the ATEM
 * Mini — the schema is ATEM-shaped, not a generic source collection (docs/goals.md).
 */
export interface Source {
  kind: "atem";
  /** The configured ATEM IP, or null until the user sets one in settings. */
  ip: string | null;
  connection: SourceConnection;
}

/**
 * The unit a device binds to (e.g. ATEM input 1). Its label comes from the source
 * (the ATEM's own input names) — there is no separate "camera" entity.
 */
export interface Input {
  id: number;
  label: string;
  tally: Tally;
}

/**
 * A device is *assigned* (shows its input's tally), *unassigned* (connected but
 * not yet bound to an input), or *offline* (known but not currently connected).
 */
export type DeviceState = "assigned" | "unassigned" | "offline";

// The transport and log-level vocabularies are **open unions** centralised here, never copied
// as string literals across files: the sidecar, the UI (via `$ipc`) and `tools/` import these
// names. `LogLevelName` is defined beside the wire LOG codec in `protocol.ts` and re-exported.

/**
 * Which transport currently carries a device. v1.3 adds `"espnow"`. A USB-connected device
 * is shown with a wired indicator; while plugged in, USB always wins (the same MAC seen on
 * both WiFi and USB appears once, as `"usb"`).
 */
export type DeviceTransport = "wifi" | "usb" | "espnow";

/**
 * What a device does when unplugged, as provisioned over USB (the wire `Transport` byte):
 * `"wifi"` joins a network, `"notx"` stays dark, `"espnow"` takes tally from a bridge.
 */
export type TransportMode = "wifi" | "notx" | "espnow";

/** Severity of a notice or a device-log line (the wire LOG level byte, named). */
export type { LogLevelName };

/** WiFi join progress, surfaced while provisioning a device over USB. */
export type DeviceWifiState = "idle" | "joining" | "connected" | "failed";

/**
 * What firmware a device runs, as far as the sidecar can tell. Produced in one place
 * (`SidecarApp`'s `#firmwareOf` in `app.ts`); every consumer reads these three states rather than
 * re-deriving them from the protocol version.
 */
export type DeviceFirmware =
  /** The device reported its firmware's own semver (a FIRMWARE message). Kept across disconnects. */
  | { kind: "reported"; version: string }
  /** It connected and reported no version: firmware older than 1.1, which predates FIRMWARE. */
  | { kind: "legacy" }
  /** Nothing to go on: it hasn't connected since the sidecar started, so it hasn't had the chance. */
  | { kind: "unknown" };

/** A physical tally light, identified by MAC with no user-given name (docs/goals.md). */
export interface Device {
  /** Full MAC, lower-case colon form — the device's identity. */
  mac: string;
  /** Short MAC tail shown in the UI to tell lights apart. */
  macTail: string;
  state: DeviceState;
  /** The input this device is bound to, or null when unassigned. */
  inputId: number | null;
  /** Per-device LED brightness, 0–255. */
  brightness: number;
  /** Protocol version from the device's HELLO, or null if it has never connected. */
  protocolVersion: number | null;
  /**
   * What the sidecar knows about the firmware the device runs. The UI compares it with the
   * firmware the app bundles to decide whether a light needs an update (`firmwareOutdated` in
   * `app/src/lib/flasher/flasher.ts`, the only place that rule lives).
   */
  firmware: DeviceFirmware;
  /** Transport currently serving the device (drives the wired indicator). */
  transport: DeviceTransport;
  /** WiFi join progress while provisioning over USB; null when not applicable. */
  wifiState: DeviceWifiState | null;
  /** Last reported RSSI in dBm while provisioning over USB; null when not applicable. */
  rssi: number | null;
  /**
   * Persisted "when unplugged" behaviour the device reports over USB (the STATUS
   * frame's transport byte): `"wifi"` joins a network, `"notx"` stays dark (USB-only
   * install). `null` for a brand-new device that has never been provisioned. Distinct
   * from `transport`, which is the transport *currently* carrying the device (`"usb"`
   * while it's plugged in). Optional so pre-v1.2 sidecar builds (which never populate
   * it) stay valid.
   */
  provisionedMode?: TransportMode | null;
  /**
   * SSID the device is provisioned to join, or null if none. Adopted from the device's
   * STATUS (read from its NVS), so it's accurate even for a device this host never
   * provisioned; falls back to the host's own record when the device hasn't reported.
   */
  ssid?: string | null;
  /**
   * True while this device is the designated ESP-NOW bridge and has confirmed bridge
   * mode (the STATUS `bridging` byte). Designation itself lives in the sidecar's store; this
   * reflects the device-confirmed state the UI should display.
   */
  bridge?: boolean;
  /**
   * The ESP-NOW channel stored on the device, as its STATUS reports it while cabled; null when it
   * isn't on USB or its firmware predates the channel byte (v3). The UI compares it with
   * {@link EspNowSettings.channel} to flag a light that won't be on the rig's channel.
   */
  espnowChannel: number | null;
}

/**
 * The bridge's ESP-NOW transmit power setting. `"full"` is the radio's maximum (18 dBm: the SDK
 * rounds the requested 19.5 down); `"reduced"` is 8.5 dBm, for boards whose antenna misbehaves at
 * full power. Only a v4 bridge honours it; an older one always transmits at full power.
 */
export type BridgeTxPower = "full" | "reduced";

/** The rig-wide ESP-NOW settings, held by the sidecar beside the bridge designation. */
export interface EspNowSettings {
  /**
   * The channel the bridge runs on and every newly provisioned ESP-NOW light is given (1–13).
   * Persisted in the state file.
   */
  channel: number;
  /**
   * The designated bridge's transmit power (sent to v4 bridges only). Runtime-only: "full" on
   * every app launch, never written to the state file.
   */
  bridgeTxPower: BridgeTxPower;
  /**
   * MACs of the ESP-NOW lights the sidecar knows of (its state file) whose firmware predates
   * channel hunting (protocol < 4): they stay on their stored channel, so after a channel change
   * each needs re-cabling (or a firmware update) to follow. Excludes the designated bridge, which
   * SET_BRIDGE retunes. Every MAC is also in {@link AppState.devices}.
   */
  legacyLights: string[];
  /**
   * MACs of known devices whose protocol version is unknown: nothing has been heard from them
   * since this TallyBot started recording versions (the released app's state file has none), and
   * no STATUS has reported them on WiFi or No-TX. A recorded SSID doesn't exclude one: firmware
   * keeps its WiFi credentials when switched to ESP-NOW. Each may be an ESP-NOW light too old to follow a channel change; the UI says it
   * hasn't been seen since the update and may not follow. A device leaves this list once it
   * connects. Excludes the designated bridge. Disjoint from {@link legacyLights}; every MAC is also
   * in {@link AppState.devices}.
   */
  unseenLights: string[];
}

/**
 * The override layer that can block program output, forcing every input to idle.
 * Present from v1 but inactive until an override source (e.g. OBS off the ATEM
 * scene) is configured (docs/goals.md).
 */
export interface ProgramGate {
  active: boolean;
  /** Human label of the override source when one is configured, else null. */
  source: string | null;
}

/**
 * A condition the operator must see that the sidecar knows about: the ATEM refusing a
 * connection, the state file failing to save, a light logging an error. A fault is *state*, not
 * an event: it stays in every snapshot until its condition clears, so a UI that starts late or
 * reloads still sees it (a one-shot message is a {@link NoticeEvent}). Raised and cleared in one
 * place, `SidecarApp`'s fault book (`faults.ts`), and every one is also written to the log.
 */
export interface Fault {
  /** The condition, unique within {@link AppState.faults}: `atem`, `state.write`, `device:<mac>:log`, … */
  key: string;
  level: "warn" | "error";
  /** Operator-facing: what failed and, where there is one, what to do. */
  message: string;
  /** The light the fault belongs to, or null for one about the app as a whole. */
  mac: string | null;
}

/** The full state snapshot the engine produces and the UI renders. */
export interface AppState {
  source: Source;
  inputs: Input[];
  devices: Device[];
  programGate: ProgramGate;
  /**
   * Every live {@link Fault}, oldest first. Added by the orchestrator, not the pure engine.
   */
  faults: Fault[];
  /** The rig-wide ESP-NOW channel and bridge power, and the lights that can't follow a change. */
  espnow: EspNowSettings;
  /**
   * True when the sidecar is running against the fake ATEM (the dev entry point,
   * `tools/src/sidecar-fake-main.ts`). The UI uses it to make the board's input keys
   * clickable so they can drive the simulated program. Absent/false in production.
   */
  dev?: boolean;
}

// ── Sidecar → UI events ───────────────────────────────────────────────────────

/** A full state snapshot. The sidecar emits whole snapshots — simplest to reason about. */
export interface StateEvent {
  type: "state";
  state: AppState;
}

/** An out-of-band message for the UI, e.g. the "update firmware" warning. */
export interface NoticeEvent {
  type: "notice";
  level: LogLevelName;
  message: string;
}

/** One switcher found by a {@link ScanSourcesCommand} sweep. */
export interface SourceScanHit {
  ip: string;
  /** The ATEM model string ("ATEM Mini Pro"), or null if it didn't report one. */
  product: string | null;
}

/**
 * Progress/result of a settings "Scan". The sidecar emits `scanning` when a sweep
 * begins and `done` (with `found` populated, or `error` set) when it finishes — the
 * scan is fire-and-forget, so the UI keys its own spinner off these two events.
 */
export interface SourceScanEvent {
  type: "sourceScan";
  status: "scanning" | "done";
  found: SourceScanHit[];
  error: string | null;
}

/**
 * A device-log line: a light's own `LOG` frame (over USB, or relayed by an ESP-NOW bridge), or a
 * transport's note on a light. The webview doesn't read these; every line is in the engine's log
 * file, and a WARN/ERROR line also becomes the light's fault in {@link AppState.faults}.
 */
export interface DeviceLogEvent {
  type: "deviceLog";
  mac: string;
  level: LogLevelName;
  text: string;
}

export type SidecarEvent =
  | StateEvent
  | NoticeEvent
  | SourceScanEvent
  | DeviceLogEvent;

// ── UI → sidecar commands ───────────────────────────────────────────────────────
// Assignment & identify happen on the canvas; setSource is the settings window
// (docs/design.md). Devices are addressed by MAC.

/** Bind a device to an input. */
export interface AssignDeviceCommand {
  type: "assignDevice";
  mac: string;
  inputId: number;
}

/** Unbind a device, returning it to the unassigned dock. */
export interface UnassignDeviceCommand {
  type: "unassignDevice";
  mac: string;
}

/**
 * Flash a device so the operator can physically locate it. The sidecar serves this by
 * streaming a white/off SET_COLOR burst to the device (see app.ts) — there's no device-level
 * IDENTIFY event; the firmware just renders the strobe like any other colour.
 */
export interface IdentifyDeviceCommand {
  type: "identifyDevice";
  mac: string;
}

/** Set a device's LED brightness (0–255). */
export interface SetBrightnessCommand {
  type: "setBrightness";
  mac: string;
  brightness: number;
}

/** Set the source (ATEM) IP from settings. */
export interface SetSourceCommand {
  type: "setSource";
  ip: string;
}

/** Sweep the local subnet(s) for ATEM switchers (the settings "Scan" button). */
export interface ScanSourcesCommand {
  type: "scanSources";
}

/**
 * Ask the sidecar to re-emit the current {@link AppState} at once. The UI sends this
 * the moment its event listener is ready, because the sidecar emits state as it
 * happens and Tauri doesn't buffer events for listeners that aren't registered yet —
 * so any snapshot produced during start-up (a fast source connect, devices already
 * online) would otherwise be lost until the next change. Idempotent.
 */
export interface RequestStateCommand {
  type: "requestState";
}

/**
 * DEV/SIMULATOR ONLY: put `inputId` on the fake ATEM's program output (the previously
 * live input drops to preview). The production sidecar ignores this — TallyBot reads
 * ATEM state and must never drive a real switcher; only the fake-ATEM dev entry
 * (`tools/src/sidecar-fake-main.ts`) acts on it. Sent only when {@link AppState.dev}.
 */
export interface SetProgramCommand {
  type: "setProgram";
  inputId: number;
}

/**
 * Provision a USB-connected device's WiFi creds. The device persists them and attempts a
 * validating join immediately, reporting progress in its STATUS (`wifiState`/`rssi` on the
 * device) so the wizard confirms a join *before* the cable is pulled.
 */
export interface ProvisionWifiCommand {
  type: "provisionWifi";
  mac: string;
  ssid: string;
  password: string;
}

/**
 * Set what a USB-connected device does when unplugged: `"wifi"` (join the provisioned
 * network), `"notx"` (WiFi disabled — wired-only), or `"espnow"` (receive tally from a
 * bridge over ESP-NOW — no network, no credentials).
 */
export interface SetTransportCommand {
  type: "setTransport";
  mac: string;
  mode: TransportMode;
}

/**
 * Designate a USB-connected device as *the* ESP-NOW bridge (one per session; designating
 * a new MAC replaces the old). `mac: null` un-designates. The sidecar persists the
 * designation and re-asserts bridge mode (runtime-only on the device) on every USB
 * reconnect; only offered for devices reporting protocol version ≥ 3.
 */
export interface SetBridgeCommand {
  type: "setBridge";
  mac: string | null;
}

/**
 * Set the rig's ESP-NOW channel (an integer in 1–13; anything else is refused with a notice).
 * The sidecar persists it, retunes a cabled bridge at once (a v4 bridge in place, an older one by
 * leaving and re-entering bridge mode), and gives it to every light provisioned for ESP-NOW from
 * then on. Uncabled v4 lights find the new channel by hunting; {@link EspNowSettings.legacyLights}
 * can't.
 */
export interface SetEspNowChannelCommand {
  type: "setEspNowChannel";
  channel: number;
}

/**
 * Set the bridge's transmit power. Persisted, and applied at once to a cabled v4 bridge; an older
 * bridge can't change it (the sidecar says so with a notice).
 */
export interface SetBridgeTxPowerCommand {
  type: "setBridgeTxPower";
  txPower: BridgeTxPower;
}

export type UiCommand =
  | AssignDeviceCommand
  | UnassignDeviceCommand
  | IdentifyDeviceCommand
  | SetBrightnessCommand
  | SetSourceCommand
  | ScanSourcesCommand
  | RequestStateCommand
  | SetProgramCommand
  | ProvisionWifiCommand
  | SetTransportCommand
  | SetBridgeCommand
  | SetEspNowChannelCommand
  | SetBridgeTxPowerCommand;

// ── Transport (NDJSON over stdio) ───────────────────────────────────────────────

/**
 * Every message type, kept in sync with the unions above by `satisfies` — adding
 * a message without listing it here (or vice versa) is a type error.
 */
export const EVENT_TYPES = [
  "state",
  "notice",
  "sourceScan",
  "deviceLog",
] as const satisfies readonly SidecarEvent["type"][];
export const COMMAND_TYPES = [
  "assignDevice",
  "unassignDevice",
  "identifyDevice",
  "setBrightness",
  "setSource",
  "scanSources",
  "requestState",
  "setProgram",
  "provisionWifi",
  "setTransport",
  "setBridge",
  "setEspNowChannel",
  "setBridgeTxPower",
] as const satisfies readonly UiCommand["type"][];

const eventTypes = new Set<string>(EVENT_TYPES);
const commandTypes = new Set<string>(COMMAND_TYPES);

/** Serialize a message to a single NDJSON line (trailing newline included). */
export function serializeMessage(message: SidecarEvent | UiCommand): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Parse one NDJSON line as a message whose `type` is one of `types`, or null if it isn't
 * valid JSON or carries another `type`. Validation is intentionally light — this is a
 * trusted local pipe, not untrusted network input. Shared with the USB bridge vocabulary
 * (`usb-bridge.ts`), which rides the same pipe.
 */
export function parseTypedLine<T>(line: string, types: ReadonlySet<string>): T | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && types.has(type) ? (value as T) : null;
}

/** Parse one NDJSON line into a sidecar→UI event, or null (see {@link parseTypedLine}). */
export function parseEvent(line: string): SidecarEvent | null {
  return parseTypedLine<SidecarEvent>(line, eventTypes);
}

/** Parse one NDJSON line into a UI→sidecar command, or null (see {@link parseTypedLine}). */
export function parseCommand(line: string): UiCommand | null {
  return parseTypedLine<UiCommand>(line, commandTypes);
}

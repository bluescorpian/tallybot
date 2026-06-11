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
 * The nouns mirror `GOALS.md` ("Core concepts") on purpose — source, input,
 * device, program-gate — so the schema, persisted state, and UI all line up.
 */

// ── Domain ──────────────────────────────────────────────────────────────────

/**
 * Per-input tally state, derived from the source. `unknown` is the **fault** state:
 * the sidecar can't trust the source (the ATEM is disconnected/reconnecting, or it's
 * connected but hasn't reported a program input), so it must NOT claim a confident
 * `idle` ("you're clear"). A device on an `unknown` input is shown a flashing-blue
 * fault, never green — see `ARCHITECTURE.md` "Failure signalling".
 */
export type Tally = "live" | "preview" | "idle" | "unknown";

export type SourceConnection = "connected" | "connecting" | "disconnected";

/**
 * What produces inputs and reports which are live/preview. v1 hardcodes the ATEM
 * Mini — the schema is ATEM-shaped, not a generic source collection (GOALS.md).
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

/**
 * Which transport currently carries a device. **Open union** (centralised here, never
 * copied as a string literal across files): v1.3 adds `"espnow"`. A USB-connected device
 * is shown with a wired indicator; while plugged in, USB always wins (the same MAC seen on
 * both WiFi and USB appears once, as `"usb"`).
 */
export type DeviceTransport = "wifi" | "usb" | "espnow";

/** WiFi join progress, surfaced while provisioning a device over USB. */
export type DeviceWifiState = "idle" | "joining" | "connected" | "failed";

/** A physical tally light, identified by MAC with no user-given name (GOALS.md). */
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
  /** True when the device's protocol version is below the server's minimum. */
  firmwareOutdated: boolean;
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
  provisionedMode?: "wifi" | "notx" | "espnow" | null;
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
}

/**
 * The override layer that can block program output, forcing every input to idle.
 * Present from v1 but inactive until an override source (e.g. OBS off the ATEM
 * scene) is configured (GOALS.md).
 */
export interface ProgramGate {
  active: boolean;
  /** Human label of the override source when one is configured, else null. */
  source: string | null;
}

/** The full state snapshot the engine produces and the UI renders. */
export interface AppState {
  source: Source;
  inputs: Input[];
  devices: Device[];
  programGate: ProgramGate;
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
  level: "info" | "warn" | "error";
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
 * The shell detected an ESP32-C3 on USB that isn't running TallyBot firmware (no HELLO
 * within the detect window). The UI may offer to flash it (flashing is deferred — the
 * event is wired now so the contract is stable).
 */
export interface UnflashedDeviceDetectedEvent {
  type: "unflashedDeviceDetected";
  /** The serial port path/name (e.g. `/dev/ttyACM0`, `COM5`). */
  port: string;
}

/**
 * A device-log line, sourced from a USB `LOG` frame. The live device-log channel over USB
 * directly attacks the deferred WiFi-join problem (`docs/wifi-troubleshooting.md`) — the
 * wizard streams join progress/verdicts straight from the device.
 */
export interface DeviceLogEvent {
  type: "deviceLog";
  mac: string;
  level: "info" | "warn" | "error";
  text: string;
}

export type SidecarEvent =
  | StateEvent
  | NoticeEvent
  | SourceScanEvent
  | UnflashedDeviceDetectedEvent
  | DeviceLogEvent;

// ── UI → sidecar commands ───────────────────────────────────────────────────────
// Assignment & identify happen on the canvas; setSource is the settings window
// (DESIGN.md). Devices are addressed by MAC.

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
 * validating join immediately, streaming progress via `deviceLog` + the device's
 * `wifiState`/`rssi` so the wizard confirms a join *before* the cable is pulled.
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
  mode: "notx" | "wifi" | "espnow";
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
  | SetBridgeCommand;

// ── Transport (NDJSON over stdio) ───────────────────────────────────────────────

/**
 * Every message type, kept in sync with the unions above by `satisfies` — adding
 * a message without listing it here (or vice versa) is a type error.
 */
export const EVENT_TYPES = [
  "state",
  "notice",
  "sourceScan",
  "unflashedDeviceDetected",
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
] as const satisfies readonly UiCommand["type"][];

const eventTypes = new Set<string>(EVENT_TYPES);
const commandTypes = new Set<string>(COMMAND_TYPES);

/** Serialize a message to a single NDJSON line (trailing newline included). */
export function serializeMessage(message: SidecarEvent | UiCommand): string {
  return `${JSON.stringify(message)}\n`;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function discriminant(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Parse one NDJSON line into a sidecar→UI event, or null if it isn't valid JSON
 * or carries an unknown `type`. Validation is intentionally light — this is a
 * trusted local pipe, not untrusted network input.
 */
export function parseEvent(line: string): SidecarEvent | null {
  const value = parseJson(line);
  const type = discriminant(value);
  return type !== undefined && eventTypes.has(type) ? (value as SidecarEvent) : null;
}

/** Parse one NDJSON line into a UI→sidecar command, or null (see {@link parseEvent}). */
export function parseCommand(line: string): UiCommand | null {
  const value = parseJson(line);
  const type = discriminant(value);
  return type !== undefined && commandTypes.has(type) ? (value as UiCommand) : null;
}

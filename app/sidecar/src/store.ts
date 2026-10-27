/**
 * Persisted configuration — the device-to-input assignments (and the ATEM IP) that
 * must survive an app restart (docs/architecture.md "Device Identity").
 *
 * State is a small JSON file: the source IP plus, keyed by device MAC, the input a
 * device is assigned to and its per-device brightness. The in-memory copy is the
 * working set; every mutation writes the file back **atomically** (temp file, fsync,
 * rename) so neither a crash nor a power cut mid-write leaves a torn file, and writes are
 * serialised so they can't interleave.
 *
 * Loading never silently throws configuration away:
 *   • a missing file yields empty defaults (the first save creates it);
 *   • a file that isn't a JSON object is kept beside it as `<name>.corrupt-<timestamp>` and
 *     the store starts empty ({@link StoreProblem} says so, for the operator);
 *   • a file whose `version` is newer than {@link SCHEMA_VERSION} (or unreadable) is opened
 *     **read-only**: what this version recognises is used, but it's never written back, so a
 *     downgrade can't drop what the newer app stored;
 *   • an older file runs the {@link MIGRATIONS} chain up to the current version;
 *   • within a recognised file, a bad entry is salvaged field-by-field rather than costing the
 *     user their whole configuration.
 *
 * The store owns *persistence only* — it has no opinion about tally or sockets. The
 * orchestrator (`src/app.ts`) merges this with live connection state for the engine.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_BRIGHTNESS, ESPNOW_CHANNEL, Transport, isEspnowChannel, isMac } from "./protocol.ts";

/** One device's persisted configuration. */
export interface DeviceConfig {
  /** The input this device is assigned to, or null when unassigned. */
  inputId: number | null;
  /** Per-device LED brightness, 0–255. */
  brightness: number;
  /**
   * SSID the device was provisioned to join. Set when the app provisions it, and adopted from
   * the SSID the device's STATUS reports while cabled (its NVS value, the source of truth), so
   * the board can show "On <network>" for a light that isn't plugged in. Omitted when unset (so
   * a device with no WiFi config keeps the minimal `{ inputId, brightness }` shape).
   */
  ssid?: string;
  /**
   * The protocol version the device last reported (its HELLO), and its provisioned transport (the
   * wire {@link Transport} value its STATUS reports, or ESP-NOW when it was heard over the radio).
   * Recorded so the sidecar knows which ESP-NOW lights can't follow a channel change while they
   * aren't connected. Omitted until known.
   */
  protocolVersion?: number;
  transport?: number;
}

/** What {@link ConfigStore.noteReported} records about a device; an absent field is left as it is. */
export interface DeviceReport {
  protocolVersion?: number;
  transport?: number;
}

/** Current on-disk schema version. A non-additive format change bumps it and adds a {@link MIGRATIONS} step. */
export const SCHEMA_VERSION = 1;

/**
 * Upgrade steps, keyed by the version they upgrade *from*: `MIGRATIONS[n]` turns a parsed
 * version-`n` file into version `n + 1`. Run in order on load, so any older file reaches
 * {@link SCHEMA_VERSION}. Every format change so far was additive within version 1 (`bridgeMac`,
 * `ssid`, `espnowChannel`, a device's `protocolVersion`/`transport`, dropping short MAC keys),
 * which {@link coerceShape} absorbs, so the chain is empty.
 */
const MIGRATIONS: Readonly<Record<number, (file: Record<string, unknown>) => Record<string, unknown>>> = {};

/** Why the loaded file isn't the working set as-is, for the operator (the orchestrator words it). */
export type StoreProblem =
  /** The file couldn't be parsed. `keptAs` is where it was moved, or null if that failed too (then the store is read-only). */
  | { kind: "corrupt"; keptAs: string | null }
  /** The file is from a newer TallyBot (or its version is unreadable): opened read-only. */
  | { kind: "newer"; version: unknown };

interface PersistedShape {
  version: number;
  sourceIp: string | null;
  /**
   * MAC of the device designated as *the* ESP-NOW bridge, or null. Session-level (like
   * `sourceIp`), not per-device — there is one bridge at a time, and the designation must
   * survive restarts so a replugged bridge re-asserts automatically (v1.3 spec).
   */
  bridgeMac: string | null;
  /** The rig's ESP-NOW channel (1–13), session-level like `bridgeMac`. */
  espnowChannel: number;
  devices: Record<string, DeviceConfig>;
}

/**
 * The session-level settings, as loaded and held in memory. Everything here is persisted, so a
 * runtime-only setting (the bridge's transmit power) lives in the orchestrator instead.
 */
interface Session {
  sourceIp: string | null;
  bridgeMac: string | null;
  espnowChannel: number;
}

const DEFAULT_SESSION: Session = {
  sourceIp: null,
  bridgeMac: null,
  espnowChannel: ESPNOW_CHANNEL,
};

function isByte(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

/** An input id the store accepts: a non-negative integer (ATEM input numbers). */
function isInputId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The store's key for a MAC: lower-case, as every transport reports it. Throws on anything but a full MAC. */
function macKey(mac: string): string {
  if (!isMac(mac)) throw new RangeError(`not a MAC address: "${mac}"`);
  return mac.toLowerCase();
}

/** Coerce one parsed device entry, or null if it has nothing usable. */
function coerceDevice(value: unknown): DeviceConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as {
    inputId?: unknown;
    brightness?: unknown;
    ssid?: unknown;
    protocolVersion?: unknown;
    transport?: unknown;
  };
  const inputId = isInputId(raw.inputId) ? raw.inputId : null;
  const brightness = isByte(raw.brightness) ? raw.brightness : DEFAULT_BRIGHTNESS;
  const device: DeviceConfig = { inputId, brightness };
  // Keep the key absent when there's no SSID, so a non-WiFi device stays `{ inputId, brightness }`.
  if (typeof raw.ssid === "string" && raw.ssid !== "") device.ssid = raw.ssid;
  if (isByte(raw.protocolVersion)) device.protocolVersion = raw.protocolVersion;
  if (isByte(raw.transport)) device.transport = raw.transport;
  return device;
}

/** Salvage whatever is recognisable from a parsed file; unknown shapes → defaults. */
function coerceShape(value: unknown): { session: Session; devices: Map<string, DeviceConfig> } {
  const devices = new Map<string, DeviceConfig>();
  if (typeof value !== "object" || value === null) return { session: { ...DEFAULT_SESSION }, devices };
  const raw = value as {
    sourceIp?: unknown;
    bridgeMac?: unknown;
    espnowChannel?: unknown;
    devices?: unknown;
  };
  const sourceIp = typeof raw.sourceIp === "string" ? raw.sourceIp : null;
  // A stored bridge MAC must be a full MAC to be trusted (anything else is garbage from a hand-
  // edited or corrupt file); fall back to "no bridge" rather than re-asserting onto a bogus MAC.
  const bridgeMac = typeof raw.bridgeMac === "string" && isMac(raw.bridgeMac) ? raw.bridgeMac.toLowerCase() : null;
  // A channel the firmware would refuse falls back to the default rather than strand the bridge.
  const espnowChannel =
    typeof raw.espnowChannel === "number" && isEspnowChannel(raw.espnowChannel)
      ? raw.espnowChannel
      : ESPNOW_CHANNEL;
  if (typeof raw.devices === "object" && raw.devices !== null) {
    for (const [mac, entry] of Object.entries(raw.devices)) {
      // Drop keys that aren't a full MAC. Devices are keyed by their 6-octet MAC;
      // a short key (e.g. a 3-octet tail) is legacy garbage that would surface as a
      // phantom offline device, so it self-heals on load rather than persisting.
      if (!isMac(mac)) continue;
      // Lower-case, as the transports report it: a hand-edited upper-case key would otherwise be
      // a second device that never matches. The lower-case entry wins if both exist.
      const key = mac.toLowerCase();
      if (key !== mac && devices.has(key)) continue;
      const device = coerceDevice(entry);
      if (device) devices.set(key, device);
    }
  }
  return { session: { sourceIp, bridgeMac, espnowChannel }, devices };
}

/** A parsed file's version: absent means 1 (the first format wrote it, but be lenient). */
function fileVersion(file: Record<string, unknown>): unknown {
  return "version" in file ? file["version"] : 1;
}

function isKnownVersion(version: unknown): version is number {
  return typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= SCHEMA_VERSION;
}

/** Run the migration chain from `version` up to {@link SCHEMA_VERSION}. */
function migrate(file: Record<string, unknown>, version: number): Record<string, unknown> {
  let current = file;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no state-file migration from version ${v}`);
    current = step(current);
  }
  return current;
}

/** Where a corrupt file is kept: beside it, stamped so a second one doesn't overwrite the first. */
function corruptName(filePath: string, now: Date): string {
  return `${filePath}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
}

export interface LoadOptions {
  /** The clock behind a corrupt file's timestamp (tests pin it). */
  now?: () => Date;
}

export class ConfigStore {
  readonly #filePath: string;
  readonly #session: Session;
  /** Never write the file back: it's from a newer TallyBot, or a corrupt one couldn't be kept aside. */
  readonly #readOnly: boolean;
  /** What went wrong loading the file, or null when it loaded cleanly. */
  readonly problem: StoreProblem | null;
  readonly #devices: Map<string, DeviceConfig>;
  /** Serialises writes so two saves can't interleave on the temp file. */
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(
    filePath: string,
    session: Session,
    devices: Map<string, DeviceConfig>,
    problem: StoreProblem | null = null,
  ) {
    this.#filePath = filePath;
    this.#session = session;
    this.problem = problem;
    this.#readOnly = problem !== null && (problem.kind === "newer" || problem.keptAs === null);
    this.#devices = devices;
  }

  /**
   * Load the config at `filePath`. A missing file is not an error — it yields empty
   * defaults (the first save creates it). A corrupt or newer one is handled as the header
   * describes, and reported in {@link problem}. Other read errors propagate.
   */
  static async load(filePath: string, options: LoadOptions = {}): Promise<ConfigStore> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new ConfigStore(filePath, { ...DEFAULT_SESSION }, new Map());
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Unreadable: start from defaults rather than refuse to launch, but keep the file, since the
      // next save would otherwise overwrite every assignment with no copy left.
      const keptAs = corruptName(filePath, (options.now ?? (() => new Date()))());
      try {
        await rename(filePath, keptAs);
        return new ConfigStore(filePath, { ...DEFAULT_SESSION }, new Map(), { kind: "corrupt", keptAs });
      } catch {
        return new ConfigStore(filePath, { ...DEFAULT_SESSION }, new Map(), { kind: "corrupt", keptAs: null });
      }
    }
    const file = parsed as Record<string, unknown>;
    const version = fileVersion(file);
    if (!isKnownVersion(version)) {
      // From a newer TallyBot, or a version this can't read: use what's recognisable, write nothing.
      const { session, devices } = coerceShape(file);
      return new ConfigStore(filePath, session, devices, { kind: "newer", version });
    }
    const { session, devices } = coerceShape(migrate(file, version));
    return new ConfigStore(filePath, session, devices);
  }

  /** True when changes are kept in memory only: the file on disk is never written (see {@link problem}). */
  get readOnly(): boolean {
    return this.#readOnly;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  get sourceIp(): string | null {
    return this.#session.sourceIp;
  }

  /** MAC of the designated ESP-NOW bridge, or null when none is designated. */
  get bridgeMac(): string | null {
    return this.#session.bridgeMac;
  }

  /** The rig's ESP-NOW channel (1–13; {@link ESPNOW_CHANNEL} until one is set). */
  get espnowChannel(): number {
    return this.#session.espnowChannel;
  }

  /** The persisted config for one device, if any. */
  device(mac: string): DeviceConfig | undefined {
    return this.#devices.get(mac.toLowerCase());
  }

  /** Every persisted device entry, as `[mac, config]` pairs. */
  devices(): Array<[string, DeviceConfig]> {
    return [...this.#devices.entries()];
  }

  // ── Mutations (each persists) ────────────────────────────────────────────────
  // Each mutation validates its arguments before changing anything and throws a RangeError on a
  // bad one, so nothing that would break the next sync or the file reaches the working set.

  setSourceIp(ip: string | null): Promise<void> {
    this.#session.sourceIp = ip;
    return this.#persist();
  }

  /** Designate (or clear, with null) the ESP-NOW bridge — one per session, survives restarts. */
  setBridgeMac(mac: string | null): Promise<void> {
    this.#session.bridgeMac = mac === null ? null : macKey(mac);
    return this.#persist();
  }

  /**
   * Set the rig's ESP-NOW channel. Throws a RangeError, changing nothing, outside 1–13: a caller
   * bug, not a failed save (the orchestrator refuses a bad channel before it gets here).
   */
  setEspnowChannel(channel: number): Promise<void> {
    if (!isEspnowChannel(channel)) throw new RangeError(`not an ESP-NOW channel (1–13): ${channel}`);
    this.#session.espnowChannel = channel;
    return this.#persist();
  }

  /** Bind a device to an input (a non-negative integer). */
  assign(mac: string, inputId: number): Promise<void> {
    if (!isInputId(inputId)) throw new RangeError(`input must be a non-negative integer, got ${inputId}`);
    this.#ensure(mac).inputId = inputId;
    return this.#persist();
  }

  /** Unbind a device — its brightness is kept for when it's reassigned. */
  unassign(mac: string): Promise<void> {
    const device = this.#devices.get(macKey(mac));
    if (device) device.inputId = null;
    return this.#persist();
  }

  /** Set a device's brightness: any finite number, rounded and clamped to 0–255. */
  setBrightness(mac: string, brightness: number): Promise<void> {
    if (!Number.isFinite(brightness)) throw new RangeError(`brightness must be a number, got ${brightness}`);
    this.#ensure(mac).brightness = Math.max(0, Math.min(255, Math.round(brightness)));
    return this.#persist();
  }

  /** Remember (or clear) the SSID a device was provisioned to join over USB. */
  setSsid(mac: string, ssid: string | null): Promise<void> {
    const device = this.#ensure(mac);
    if (ssid === null || ssid === "") delete device.ssid;
    else device.ssid = ssid;
    return this.#persist();
  }

  /**
   * Record what a device reported (its protocol version, its provisioned transport). Writes only
   * when something changed, since STATUS streams; resolves at once otherwise.
   */
  noteReported(mac: string, report: DeviceReport): Promise<void> {
    const device = this.#ensure(mac);
    let changed = false;
    if (report.protocolVersion !== undefined && device.protocolVersion !== report.protocolVersion) {
      device.protocolVersion = report.protocolVersion;
      changed = true;
    }
    if (report.transport !== undefined && device.transport !== report.transport) {
      device.transport = report.transport;
      changed = true;
    }
    return changed ? this.#persist() : Promise.resolve();
  }

  #ensure(mac: string): DeviceConfig {
    const key = macKey(mac);
    let device = this.#devices.get(key);
    if (!device) {
      device = { inputId: null, brightness: DEFAULT_BRIGHTNESS };
      this.#devices.set(key, device);
    }
    return device;
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  /**
   * Wait for any in-flight and queued writes to finish (shutdown / tests). Never rejects: each
   * write's failure belongs to the mutation that queued it.
   */
  flush(): Promise<void> {
    return this.#writeChain;
  }

  /** Snapshot the working set and queue an atomic write of it (none when {@link readOnly}). */
  #persist(): Promise<void> {
    if (this.#readOnly) return this.#writeChain;
    // Prune entries that carry no real configuration so the file stays tidy. An ESP-NOW light is
    // kept regardless: the channel picker has to know about it while it's away.
    const devices: Record<string, DeviceConfig> = {};
    for (const [mac, config] of this.#devices) {
      if (
        config.inputId === null &&
        config.brightness === DEFAULT_BRIGHTNESS &&
        config.ssid == null &&
        config.transport !== Transport.ESPNOW
      )
        continue;
      const entry: DeviceConfig = { inputId: config.inputId, brightness: config.brightness };
      // Optional keys are omitted when unset (keeps the file minimal).
      if (config.ssid != null) entry.ssid = config.ssid;
      if (config.protocolVersion !== undefined) entry.protocolVersion = config.protocolVersion;
      if (config.transport !== undefined) entry.transport = config.transport;
      devices[mac] = entry;
    }
    const payload: PersistedShape = { version: SCHEMA_VERSION, ...this.#session, devices };
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    // This write's own result goes to its caller (it rejects if the write failed), but the chain
    // carries on past a failure: every write is the whole working set, so the next one retries
    // everything a failed one lost. A chain left rejected would skip every later write.
    const write = this.#writeChain.then(() => this.#writeAtomically(json));
    this.#writeChain = write.catch(() => {});
    return write;
  }

  async #writeAtomically(json: string): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const tmp = `${this.#filePath}.tmp`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(json, "utf8");
      // On disk before the rename makes it the file: without it a power cut can leave the renamed
      // file empty, which the next launch would read as corrupt.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.#filePath); // atomic on the same filesystem
  }
}

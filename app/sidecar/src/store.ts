/**
 * Persisted configuration — the device-to-input assignments (and the ATEM IP) that
 * must survive an app restart (PHASES.md "Assignment store"; ARCHITECTURE.md
 * "Device Identity").
 *
 * State is a small JSON file: the source IP plus, keyed by device MAC, the input a
 * device is assigned to and its per-device brightness. The in-memory copy is the
 * working set; every mutation writes the file back **atomically** (temp file +
 * rename) so a crash mid-write can't corrupt it, and writes are serialised so they
 * can't interleave. Loading a missing file yields empty defaults; a corrupt or
 * partially-recognised file is salvaged field-by-field rather than thrown away, so
 * a bad entry never costs the user their whole configuration.
 *
 * The store owns *persistence only* — it has no opinion about tally or sockets. The
 * orchestrator (`src/app.ts`) merges this with live connection state for the engine.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_BRIGHTNESS } from "./protocol.ts";

/** One device's persisted configuration. */
export interface DeviceConfig {
  /** The input this device is assigned to, or null when unassigned. */
  inputId: number | null;
  /** Per-device LED brightness, 0–255. */
  brightness: number;
  /**
   * SSID the device was provisioned to join over USB. The device's STATUS frame reports
   * only *whether* creds are present, never the SSID string, so the host remembers it here
   * to show "On <network>" when the device is re-plugged. Omitted when unset (so a device
   * with no WiFi config keeps the minimal `{ inputId, brightness }` shape).
   */
  ssid?: string;
}

/** Current on-disk schema version, so a future format change can migrate. */
const SCHEMA_VERSION = 1;

interface PersistedShape {
  version: number;
  sourceIp: string | null;
  devices: Record<string, DeviceConfig>;
}

function isByte(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

/** Coerce one parsed device entry, or null if it has nothing usable. */
function coerceDevice(value: unknown): DeviceConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { inputId?: unknown; brightness?: unknown; ssid?: unknown };
  const inputId =
    typeof raw.inputId === "number" && Number.isInteger(raw.inputId) ? raw.inputId : null;
  const brightness = isByte(raw.brightness) ? raw.brightness : DEFAULT_BRIGHTNESS;
  const device: DeviceConfig = { inputId, brightness };
  // Keep the key absent when there's no SSID, so a non-WiFi device stays `{ inputId, brightness }`.
  if (typeof raw.ssid === "string" && raw.ssid !== "") device.ssid = raw.ssid;
  return device;
}

/** A full MAC: six colon-separated two-hex-digit octets, e.g. `e8:3d:c1:85:dc:6c`. */
function isFullMac(mac: string): boolean {
  return /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(mac);
}

/** Salvage whatever is recognisable from a parsed file; unknown shapes → defaults. */
function coerceShape(value: unknown): { sourceIp: string | null; devices: Map<string, DeviceConfig> } {
  const devices = new Map<string, DeviceConfig>();
  if (typeof value !== "object" || value === null) return { sourceIp: null, devices };
  const raw = value as { sourceIp?: unknown; devices?: unknown };
  const sourceIp = typeof raw.sourceIp === "string" ? raw.sourceIp : null;
  if (typeof raw.devices === "object" && raw.devices !== null) {
    for (const [mac, entry] of Object.entries(raw.devices)) {
      // Drop keys that aren't a full MAC. Devices are keyed by their 6-octet MAC;
      // a short key (e.g. a 3-octet tail) is legacy garbage that would surface as a
      // phantom offline device, so it self-heals on load rather than persisting.
      if (!isFullMac(mac)) continue;
      const device = coerceDevice(entry);
      if (device) devices.set(mac, device);
    }
  }
  return { sourceIp, devices };
}

export class ConfigStore {
  readonly #filePath: string;
  #sourceIp: string | null;
  readonly #devices: Map<string, DeviceConfig>;
  /** Serialises writes so two saves can't interleave on the temp file. */
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, sourceIp: string | null, devices: Map<string, DeviceConfig>) {
    this.#filePath = filePath;
    this.#sourceIp = sourceIp;
    this.#devices = devices;
  }

  /**
   * Load the config at `filePath`. A missing file is not an error — it yields empty
   * defaults (the first save creates it). Other read errors propagate.
   */
  static async load(filePath: string): Promise<ConfigStore> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new ConfigStore(filePath, null, new Map());
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null; // corrupt JSON → start from defaults rather than refuse to launch
    }
    const { sourceIp, devices } = coerceShape(parsed);
    return new ConfigStore(filePath, sourceIp, devices);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  get sourceIp(): string | null {
    return this.#sourceIp;
  }

  /** The persisted config for one device, if any. */
  device(mac: string): DeviceConfig | undefined {
    return this.#devices.get(mac);
  }

  /** Every persisted device entry, as `[mac, config]` pairs. */
  devices(): Array<[string, DeviceConfig]> {
    return [...this.#devices.entries()];
  }

  // ── Mutations (each persists) ────────────────────────────────────────────────

  setSourceIp(ip: string | null): Promise<void> {
    this.#sourceIp = ip;
    return this.#persist();
  }

  /** Bind a device to an input. */
  assign(mac: string, inputId: number): Promise<void> {
    this.#ensure(mac).inputId = inputId;
    return this.#persist();
  }

  /** Unbind a device — its brightness is kept for when it's reassigned. */
  unassign(mac: string): Promise<void> {
    const device = this.#devices.get(mac);
    if (device) device.inputId = null;
    return this.#persist();
  }

  setBrightness(mac: string, brightness: number): Promise<void> {
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

  #ensure(mac: string): DeviceConfig {
    let device = this.#devices.get(mac);
    if (!device) {
      device = { inputId: null, brightness: DEFAULT_BRIGHTNESS };
      this.#devices.set(mac, device);
    }
    return device;
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  /** Wait for any in-flight and queued writes to finish (shutdown / tests). */
  flush(): Promise<void> {
    return this.#writeChain;
  }

  /** Snapshot the working set and queue an atomic write of it. */
  #persist(): Promise<void> {
    // Prune entries that carry no real configuration so the file stays tidy.
    const devices: Record<string, DeviceConfig> = {};
    for (const [mac, config] of this.#devices) {
      if (config.inputId === null && config.brightness === DEFAULT_BRIGHTNESS && config.ssid == null)
        continue;
      const entry: DeviceConfig = { inputId: config.inputId, brightness: config.brightness };
      if (config.ssid != null) entry.ssid = config.ssid; // omit when unset (keeps the file minimal)
      devices[mac] = entry;
    }
    const payload: PersistedShape = { version: SCHEMA_VERSION, sourceIp: this.#sourceIp, devices };
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    this.#writeChain = this.#writeChain.then(() => this.#writeAtomically(json));
    return this.#writeChain;
  }

  async #writeAtomically(json: string): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const tmp = `${this.#filePath}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.#filePath); // atomic on the same filesystem
  }
}

/**
 * The ESP-NOW transport — the third {@link DeviceServerPort}, behind a USB-connected bridge.
 *
 * An ESP-NOW light never touches the network: it talks ESP-NOW to a designated *bridge* (a
 * normal USB tally device put into bridge mode), which wraps every peer frame in a `RELAY`
 * envelope up the USB pipe and forwards `RELAY`-wrapped frames back down (see
 * `docs/architecture.md`, "ESP-NOW transport"). This class rides the existing {@link UsbTransport}:
 *
 *   • inbound  — the UsbTransport re-emits each `RELAY` frame as a `relayed` event; we decode
 *     `inner` with the shared codec and maintain a `mac → {version, lastSeen}` table with the
 *     **same 30 s expiry the TCP {@link DeviceServer} uses**, emitting the same lifecycle events
 *     so the orchestrator stays transport-agnostic (a relayed light is just an online device).
 *   • outbound — `sendColor` wraps the SET_COLOR payload in `relayPayload(targetMac, …)` and
 *     sends it to the *designated bridge's* MAC over USB; the bridge unwraps and `esp_now_send`s.
 *
 * Liveness mirrors the TCP server: a relayed HEARTBEAT refreshes the per-device timer; silence
 * past the timeout drops the light. When the **bridge itself** disconnects from USB, every
 * relayed light it carried drops at once (its only path home is gone).
 *
 * Diagnostics ride a `log` event shaped like the {@link UsbTransport}'s device-log stream (keyed by
 * the light's MAC), so they reach the same places a bridge's own LOG lines do: an expired light,
 * the edges of an outbound outage, a HEARTBEAT from a light we never saw HELLO from, and a light's
 * own relayed LOG lines (its gap report when it relinks after losing the bridge).
 */

import { EventEmitter } from "node:events";

import { type DeviceTransportEvents, announceDevice, seconds } from "./device-events.ts";
import { HEARTBEAT_TIMEOUT_MS } from "./device-server.ts";
import {
  type Color,
  type LogLevelName,
  decodeDeviceMessage,
  logLevelName,
  relayPayload,
  setColorPayload,
} from "./protocol.ts";
import type { UsbTransport } from "./usb-transport.ts";

/** How often the expiry sweep runs — coarse, since the 30 s timeout has no tight deadline. */
const EXPIRY_SWEEP_MS = 1_000;

export interface EspNowTransportOptions {
  /** Per-light silence tolerated before it's dropped (default {@link HEARTBEAT_TIMEOUT_MS}). */
  heartbeatTimeoutMs?: number;
  /** Expiry-sweep cadence (default {@link EXPIRY_SWEEP_MS}); tests shorten it. */
  sweepIntervalMs?: number;
  /**
   * Monotonic clock in ms (default `performance.now()`); injectable so tests drive expiry. Not the
   * wall clock: a system clock step (NTP sync, manual change) would drop or strand every light.
   */
  now?: () => number;
}

/** Why `sendColor` can't reach the bridge — the two cases a live outage splits into. */
type SendFailure = "no bridge designated" | "bridge not on USB";

/** One relayed light's live facts. */
interface RelayedLight {
  version: number;
  /** Monotonic time (ms, from `now`) of the last frame seen from this light; reset on every message. */
  lastSeen: number;
}

// Typed events (the interface merges with the class and is erased at build).
export interface EspNowTransport {
  on<K extends keyof DeviceTransportEvents>(event: K, listener: (...args: DeviceTransportEvents[K]) => void): this;
  emit<K extends keyof DeviceTransportEvents>(event: K, ...args: DeviceTransportEvents[K]): boolean;
}

export class EspNowTransport extends EventEmitter {
  readonly #usb: UsbTransport;
  readonly #heartbeatTimeoutMs: number;
  readonly #sweepIntervalMs: number;
  readonly #now: () => number;

  /** Lights currently linked through the bridge → their live facts. */
  readonly #lights = new Map<string, RelayedLight>();
  /**
   * The designated bridge's MAC — where outbound RELAY frames are addressed. Null until the app
   * designates one (and again whenever it un-designates); `sendColor` returns false meanwhile.
   */
  #bridgeMac: string | null = null;

  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The outbound outage in progress, or null while sends succeed. `sendColor` runs every keyframe
   * per light, so failures are logged on the edges only: once when they start, once when they stop.
   */
  #sendOutage: { reason: SendFailure; since: number; failed: number } | null = null;
  /** MACs that sent a HEARTBEAT with no HELLO first — each is logged once, not every 10 s. */
  readonly #unknownHeartbeats = new Set<string>();

  constructor(usb: UsbTransport, options: EspNowTransportOptions = {}) {
    super();
    this.#usb = usb;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? EXPIRY_SWEEP_MS;
    this.#now = options.now ?? (() => performance.now());

    this.#usb.on("relayed", ({ bridgeMac, srcMac, inner }) => this.#onRelayed(bridgeMac, srcMac, inner));
    // The bridge's only path home is its USB cable: when it unplugs, every light it relayed is
    // unreachable, so drop them all at once rather than waiting for the per-light timeout.
    this.#usb.on("deviceDisconnected", ({ mac }) => {
      if (mac === this.#bridgeMac) this.#dropAll();
    });
  }

  /** Point outbound RELAY frames at this bridge MAC (null = no bridge → sends fail). */
  setBridgeMac(mac: string | null): void {
    this.#bridgeMac = mac;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => this.#sweep(), this.#sweepIntervalMs);
    this.#sweepTimer.unref(); // liveness sweeps must never keep the process alive on their own
  }

  async stop(): Promise<void> {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#lights.clear();
  }

  // ── Outbound (host → light, via the bridge) ───────────────────────────────────────

  /**
   * Send SET_COLOR to one relayed light: wrap the shared payload in a RELAY envelope addressed to
   * the light and send it to the designated bridge over USB. Returns false when no bridge is
   * online (the keyframe re-send will reach the light once a bridge is designated again).
   */
  sendColor(mac: string, color: Color, brightness: number): boolean {
    if (this.#bridgeMac === null) return this.#sendFailed(mac, "no bridge designated");
    const sent = this.#usb.sendBridgeRelay(this.#bridgeMac, relayPayload(mac, setColorPayload(color, brightness)));
    if (!sent) return this.#sendFailed(mac, "bridge not on USB");
    if (this.#sendOutage) {
      const { reason, since, failed } = this.#sendOutage;
      this.#sendOutage = null;
      const outage = seconds(this.#now() - since);
      this.#log(mac, "info", `ESP-NOW sends to bridge ${this.#bridgeMac} recovered after ${outage} (${failed} failed, ${reason})`);
    }
    return true;
  }

  #sendFailed(mac: string, reason: SendFailure): false {
    if (this.#sendOutage?.reason === reason) {
      this.#sendOutage.failed++;
    } else {
      this.#sendOutage = { reason, since: this.#now(), failed: 1 };
      this.#log(mac, "warn", `ESP-NOW sends failing: ${reason} (bridge ${this.#bridgeMac ?? "none"})`);
    }
    return false;
  }

  #log(mac: string, level: LogLevelName, text: string): void {
    this.emit("log", { mac, level, text });
  }

  // ── Inbound (light → host, via the bridge) ────────────────────────────────────────

  #onRelayed(_bridgeMac: string, srcMac: string, inner: Uint8Array): void {
    let message;
    try {
      message = decodeDeviceMessage(inner);
    } catch (err) {
      this.emit("error", err as Error); // a corrupt relayed payload; ESP-NOW + keyframe recover
      return;
    }
    // The srcMac from the bridge's receive callback is the device identity (HEARTBEAT carries no
    // MAC), so we key off it rather than the inner payload — exactly the envelope's reason to exist.
    if (message.kind === "hello") {
      this.#unknownHeartbeats.delete(srcMac); // known now; a later orphan HEARTBEAT is news again
      this.#lights.set(srcMac, { version: message.version, lastSeen: this.#now() });
      // Re-announce on every HELLO (including a re-link), matching the TCP server — the
      // orchestrator re-pushes colour on a reconnect.
      announceDevice(this, srcMac, message.version);
    } else if (message.kind === "heartbeat") {
      // Only refresh liveness for a light we already know — a stray HEARTBEAT before HELLO can't
      // identify a version, so we wait for the HELLO that the firmware always sends first.
      const light = this.#lights.get(srcMac);
      if (light) light.lastSeen = this.#now();
      else if (!this.#unknownHeartbeats.has(srcMac)) {
        this.#unknownHeartbeats.add(srcMac);
        this.#log(srcMac, "warn", `ESP-NOW HEARTBEAT from unknown light ${srcMac} (no HELLO seen); ignoring it`);
      }
    } else if (message.kind === "firmware") {
      const light = this.#lights.get(srcMac);
      if (light) {
        light.lastSeen = this.#now();
        this.emit("firmware", { mac: srcMac, version: message.version });
      }
    } else if (message.kind === "log") {
      // A light's own LOG line (its relink gap report), relayed up by the bridge. Like any valid
      // frame on TCP it proves a known light alive; an unknown one's line is still worth surfacing.
      const light = this.#lights.get(srcMac);
      if (light) light.lastSeen = this.#now();
      this.#log(srcMac, logLevelName(message.level), message.text);
    }
    // STATUS never rides ESP-NOW (USB-only); anything else is ignored.
  }

  /** Drop every relayed light (the bridge went away). */
  #dropAll(): void {
    for (const mac of [...this.#lights.keys()]) {
      this.#lights.delete(mac);
      this.emit("deviceDisconnected", { mac });
    }
  }

  /** Expire lights that have gone silent past the timeout (mirrors the TCP per-device timer). */
  #sweep(): void {
    const now = this.#now();
    const cutoff = now - this.#heartbeatTimeoutMs;
    for (const [mac, light] of [...this.#lights]) {
      if (light.lastSeen <= cutoff) {
        this.#lights.delete(mac);
        const silent = seconds(now - light.lastSeen);
        this.#log(mac, "warn", `ESP-NOW light ${mac} expired: silent for ${silent} (timeout ${seconds(this.#heartbeatTimeoutMs)})`);
        this.emit("deviceDisconnected", { mac });
      }
    }
  }
}

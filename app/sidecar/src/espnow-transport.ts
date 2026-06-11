/**
 * The ESP-NOW transport — the third {@link DeviceServerPort}, behind a USB-connected bridge.
 *
 * An ESP-NOW light never touches the network: it talks ESP-NOW to a designated *bridge* (a
 * normal USB tally device put into bridge mode), which wraps every peer frame in a `RELAY`
 * envelope up the USB pipe and forwards `RELAY`-wrapped frames back down (see
 * `docs/spec/esp-now-transport.md`). This class rides the existing {@link UsbTransport}:
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
 */

import { EventEmitter } from "node:events";

import { HEARTBEAT_TIMEOUT_MS } from "./device-server.ts";
import { type Color, decodeDeviceMessage, isSupportedVersion, relayPayload, setColorPayload } from "./protocol.ts";
import type { UsbTransport } from "./usb-transport.ts";

/** How often the expiry sweep runs — coarse, since the 30 s timeout has no tight deadline. */
const EXPIRY_SWEEP_MS = 1_000;

export interface EspNowTransportOptions {
  /** Per-light silence tolerated before it's dropped (default {@link HEARTBEAT_TIMEOUT_MS}). */
  heartbeatTimeoutMs?: number;
  /** Expiry-sweep cadence (default {@link EXPIRY_SWEEP_MS}); tests shorten it. */
  sweepIntervalMs?: number;
  /** Clock source (injectable so tests drive expiry without the wall clock). */
  now?: () => number;
}

/** One relayed light's live facts. */
interface RelayedLight {
  version: number;
  /** Timestamp (ms) of the last frame seen from this light; reset on every message. */
  lastSeen: number;
}

// Typed events (the interface merges with the class and is erased at build).
export interface EspNowTransport {
  on(event: "deviceConnected", listener: (info: { mac: string; version: number }) => void): this;
  on(event: "deviceDisconnected", listener: (info: { mac: string }) => void): this;
  on(event: "deviceUnsupported", listener: (info: { mac: string; version: number }) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
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

  constructor(usb: UsbTransport, options: EspNowTransportOptions = {}) {
    super();
    this.#usb = usb;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? EXPIRY_SWEEP_MS;
    this.#now = options.now ?? (() => Date.now());

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

  /** MACs of all lights currently linked through the bridge. */
  connectedMacs(): string[] {
    return [...this.#lights.keys()];
  }

  // ── Outbound (host → light, via the bridge) ───────────────────────────────────────

  /**
   * Send SET_COLOR to one relayed light: wrap the shared payload in a RELAY envelope addressed to
   * the light and send it to the designated bridge over USB. Returns false when no bridge is
   * online (the keyframe re-send will reach the light once a bridge is designated again).
   */
  sendColor(mac: string, color: Color, brightness: number): boolean {
    if (this.#bridgeMac === null) return false;
    return this.#usb.sendBridgeRelay(this.#bridgeMac, relayPayload(mac, setColorPayload(color, brightness)));
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
      this.#lights.set(srcMac, { version: message.version, lastSeen: this.#now() });
      if (!isSupportedVersion(message.version)) {
        this.emit("deviceUnsupported", { mac: srcMac, version: message.version });
      }
      // Re-announce on every HELLO (including a re-link), matching the TCP server — the
      // orchestrator re-pushes colour on a reconnect.
      this.emit("deviceConnected", { mac: srcMac, version: message.version });
    } else if (message.kind === "heartbeat") {
      // Only refresh liveness for a light we already know — a stray HEARTBEAT before HELLO can't
      // identify a version, so we wait for the HELLO that the firmware always sends first.
      const light = this.#lights.get(srcMac);
      if (light) light.lastSeen = this.#now();
    }
    // STATUS/LOG never ride ESP-NOW (USB-only frames); anything else is ignored.
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
    const cutoff = this.#now() - this.#heartbeatTimeoutMs;
    for (const [mac, light] of [...this.#lights]) {
      if (light.lastSeen <= cutoff) {
        this.#lights.delete(mac);
        this.emit("deviceDisconnected", { mac });
      }
    }
  }
}

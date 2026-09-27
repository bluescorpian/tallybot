/**
 * Fans the `DeviceServerPort` the orchestrator depends on out over several transports
 * (TCP, USB, and — in v1.3 — ESP-NOW), deduping by MAC. It is an **N-transport
 * registry**, not a TCP-vs-USB binary: members are an ordered list and the *first*
 * member holding a MAC owns it (so list USB before WiFi → "USB wins"). v1.3 adds a
 * third entry instead of rewriting the dedup.
 *
 * Dedup rules (per MAC):
 *   • first transport to hold it ⇒ emit `deviceConnected` (tagged with that transport);
 *   • a higher-priority transport taking over (e.g. USB appears while it's on WiFi) ⇒
 *     re-emit `deviceConnected` with the new owner (the orchestrator re-tags + re-pushes);
 *   • a non-owner transport dropping ⇒ suppressed;
 *   • the owner dropping with a lower-priority transport still present ⇒ re-emit
 *     `deviceConnected` for the new owner (the device "reverts", e.g. USB unplugged → WiFi);
 *   • the last transport dropping ⇒ emit `deviceDisconnected`.
 *
 * Outgoing `sendColor` routes to the current owner. Provisioning + diagnostics
 * (USB-only) are delegated to the supplied `UsbTransport`.
 */

import { EventEmitter } from "node:events";

import type { DeviceServerPort, ProvisioningPort } from "./app.ts";
import type { DeviceTransport } from "./ipc.ts";
import type { Color } from "./protocol.ts";
import type { UsbStatus, UsbTransport } from "./usb-transport.ts";

/** One transport plugged into the composite, with the tag devices on it carry. */
export interface CompositeMember {
  transport: DeviceTransport;
  port: DeviceServerPort;
}

// Typed events (the interface merges with the class and is erased at build).
export interface CompositeDeviceServer {
  on(event: "deviceConnected", listener: (info: { mac: string; version: number }) => void): this;
  on(event: "deviceDisconnected", listener: (info: { mac: string }) => void): this;
  on(event: "deviceUnsupported", listener: (info: { mac: string; version: number }) => void): this;
  on(event: "status", listener: (status: UsbStatus) => void): this;
  on(event: "log", listener: (entry: { mac: string; level: "info" | "warn" | "error"; text: string }) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class CompositeDeviceServer extends EventEmitter implements DeviceServerPort, ProvisioningPort {
  readonly #members: CompositeMember[];
  readonly #usb: UsbTransport | null;
  /** mac → (member index → reported version), for every transport currently holding it. */
  readonly #presence = new Map<string, Map<number, number>>();

  /**
   * @param members transports in **priority order** — the first one holding a MAC owns it.
   * @param usb the provisioning/diagnostics-capable transport (its events are re-emitted here).
   */
  constructor(members: CompositeMember[], usb: UsbTransport | null = null) {
    super();
    this.#members = members;
    this.#usb = usb;

    members.forEach((member, index) => {
      member.port.on("deviceConnected", ({ mac, version }) => this.#onConnect(index, mac, version));
      member.port.on("deviceDisconnected", ({ mac }) => this.#onDisconnect(index, mac));
      member.port.on("deviceUnsupported", (info) => this.emit("deviceUnsupported", info));
      member.port.on("error", (err) => this.emit("error", err as Error));
    });

    if (usb) {
      usb.on("status", (status) => this.emit("status", status));
      usb.on("log", (entry) => this.emit("log", entry));
    }
  }

  async start(): Promise<void> {
    await Promise.all(this.#members.map((m) => m.port.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.#members.map((m) => m.port.stop()));
  }

  // ── Routing ────────────────────────────────────────────────────────────────────

  /** The owning member index for a MAC (lowest index present), or -1 if none. */
  #ownerIndex(mac: string): number {
    const holders = this.#presence.get(mac);
    if (!holders) return -1;
    let owner = Infinity;
    for (const index of holders.keys()) owner = Math.min(owner, index);
    return owner === Infinity ? -1 : owner;
  }

  /** Which transport currently serves a MAC (for the wired indicator), or null. */
  transportOf(mac: string): DeviceTransport | null {
    const owner = this.#ownerIndex(mac);
    return owner < 0 ? null : this.#members[owner]!.transport;
  }

  sendColor(mac: string, color: Color, brightness: number): boolean {
    const owner = this.#ownerIndex(mac);
    return owner < 0 ? false : this.#members[owner]!.port.sendColor(mac, color, brightness);
  }

  // ── Provisioning + diagnostics (USB-only) ───────────────────────────────────────

  provisionWifi(mac: string, ssid: string, password: string): boolean {
    return this.#usb?.provisionWifi(mac, ssid, password) ?? false;
  }

  setTransport(mac: string, mode: number): boolean {
    return this.#usb?.setTransport(mac, mode) ?? false;
  }

  setBridge(mac: string, enabled: boolean): boolean {
    return this.#usb?.setBridge(mac, enabled) ?? false;
  }

  requestStatus(mac: string): boolean {
    return this.#usb?.requestStatus(mac) ?? false;
  }

  // ── Dedup ──────────────────────────────────────────────────────────────────────

  #onConnect(index: number, mac: string, version: number): void {
    const holders = this.#presence.get(mac) ?? new Map<number, number>();
    holders.set(index, version);
    this.#presence.set(mac, holders);
    const owner = this.#ownerIndex(mac);

    // Re-emit only when this transport is (or becomes) the owner — a lower-priority
    // duplicate under an existing owner is suppressed. A same-owner reconnect re-emits,
    // matching the TCP server's own reconnect behaviour (the orchestrator re-pushes colour).
    if (owner === index) {
      const ownerVersion = holders.get(owner)!;
      this.emit("deviceConnected", { mac, version: ownerVersion });
    }
  }

  #onDisconnect(index: number, mac: string): void {
    const holders = this.#presence.get(mac);
    if (!holders) return;
    const wasOwner = this.#ownerIndex(mac) === index;
    holders.delete(index);

    if (holders.size === 0) {
      this.#presence.delete(mac);
      this.emit("deviceDisconnected", { mac });
      return;
    }
    // Still reachable on another transport. If the *owner* dropped, the device reverts to
    // the next-priority transport — re-announce so the orchestrator re-tags + re-pushes.
    if (wasOwner) {
      const owner = this.#ownerIndex(mac);
      this.emit("deviceConnected", { mac, version: holders.get(owner)! });
    }
  }
}

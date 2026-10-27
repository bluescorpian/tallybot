/**
 * The per-device event contract every transport speaks (TCP {@link DeviceServer}, USB
 * {@link UsbTransport}, ESP-NOW {@link EspNowTransport}) and the {@link CompositeDeviceServer}
 * re-emits, so the orchestrator's `DeviceServerPort` (`app.ts`) is transport-agnostic. A new
 * device message is declared here once, and every transport's `on`/`emit` and the port share it.
 *
 * Each entry is the listener's argument list. A transport types its `on`/`emit` from an event map
 * that extends this one, by merging an interface into its `EventEmitter` subclass:
 *
 *   export interface Foo {
 *     on<K extends keyof FooEvents>(event: K, listener: (...args: FooEvents[K]) => void): this;
 *     emit<K extends keyof FooEvents>(event: K, ...args: FooEvents[K]): boolean;
 *   }
 *
 * Not Node's generic `EventEmitter<T>`: its conditional `on` type isn't assignable to
 * `DeviceServerPort` once a transport adds events of its own (USB's `status`, TCP's `listening`).
 */

import { type LogLevelName, type UnsupportedReason, deviceCompatibility } from "./protocol.ts";

export interface DeviceTransportEvents {
  /** A device said HELLO (also on a reconnect, so the orchestrator re-pushes its colour). */
  deviceConnected: [info: { mac: string; version: number }];
  deviceDisconnected: [info: { mac: string }];
  /** The device's protocol version is outside what this sidecar speaks; `reason` says which side is stale. */
  deviceUnsupported: [info: { mac: string; version: number; reason: UnsupportedReason }];
  /**
   * The firmware version a device reports right after its HELLO (firmware that predates this never
   * does). Emitted only for a device the transport currently holds.
   */
  firmware: [info: { mac: string; version: string }];
  /** Device-keyed diagnostic lines: a device's own LOG frames, or a transport's notes on a device. */
  log: [entry: { mac: string; level: LogLevelName; text: string }];
  error: [err: Error];
}

/** The two emits {@link announceDevice} makes; any transport's typed emitter satisfies it. */
export interface DeviceAnnouncer {
  emit(event: "deviceUnsupported", ...args: DeviceTransportEvents["deviceUnsupported"]): boolean;
  emit(event: "deviceConnected", ...args: DeviceTransportEvents["deviceConnected"]): boolean;
}

/**
 * Announce a device that just said HELLO: flag a protocol version this sidecar can't fully speak
 * (`deviceUnsupported`), then `deviceConnected` either way, since the server adapts as best it can.
 */
export function announceDevice(emitter: DeviceAnnouncer, mac: string, version: number): void {
  const compatibility = deviceCompatibility(version);
  if (compatibility !== "supported") emitter.emit("deviceUnsupported", { mac, version, reason: compatibility });
  emitter.emit("deviceConnected", { mac, version });
}

/** A duration for a log line, e.g. `30.0 s`. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

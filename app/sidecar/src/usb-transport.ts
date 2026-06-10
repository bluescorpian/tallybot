/**
 * The USB transport — a thin proxy that makes a USB-cabled device look exactly like a
 * TCP one to the orchestrator. The Tauri shell owns the serial port; this class rides
 * the shell↔sidecar bridge (`usb-bridge.ts`):
 *
 *   • inbound  `usbDeviceConnected/Disconnected` → the `deviceConnected/deviceDisconnected`
 *     events the orchestrator already consumes (so it stays transport-agnostic);
 *   • inbound  `usbFrame` → decoded STATUS/LOG → `status`/`log` events (provisioning UX);
 *   • outbound `sendColor`/`provisionWifi`/`setTransport` → a `usbSend` with the
 *     payload built by the shared `protocol.ts` codecs and hex-wrapped for the bridge.
 *
 * SET_COLOR is byte-identical to TCP — literally the same payload builder — so a USB
 * device renders the same palette/animation frames (including the locate strobe) the
 * server streams.
 */

import { EventEmitter } from "node:events";

import type { DeviceWifiState } from "./ipc.ts";
import {
  type Color,
  Transport,
  WifiState,
  getStatusPayload,
  isSupportedVersion,
  setColorPayload,
  setTransportPayload,
  setWifiPayload,
} from "./protocol.ts";
import {
  type UsbInbound,
  type UsbOutbound,
  decodeUsbFrame,
  toHex,
} from "./usb-bridge.ts";

/** What the transport needs from the IPC bridge (the `IpcBridge` satisfies this). */
export interface UsbBridgePort {
  on(event: "usb", listener: (message: UsbInbound) => void): unknown;
  sendUsb(message: UsbOutbound): void;
}

/** A decoded STATUS push, normalised for the orchestrator/UI. */
export interface UsbStatus {
  mac: string;
  /** The device's *provisioned* transport mode (open enum: 0 No-TX, 1 WiFi, …). */
  mode: number;
  wifiState: DeviceWifiState;
  /** RSSI in dBm, or null when not applicable (0 on the wire). */
  rssi: number | null;
  /** The device's stored SSID read from its NVS (`""` when no creds) — device-truth, persisted host-side. */
  ssid: string;
}

const WIFI_STATE_NAME: Record<number, DeviceWifiState> = {
  [WifiState.IDLE]: "idle",
  [WifiState.JOINING]: "joining",
  [WifiState.CONNECTED]: "connected",
  [WifiState.FAILED]: "failed",
};

const LOG_LEVEL_NAME = ["info", "warn", "error"] as const;

// Typed events (the interface merges with the class and is erased at build).
export interface UsbTransport {
  on(event: "deviceConnected", listener: (info: { mac: string; version: number }) => void): this;
  on(event: "deviceDisconnected", listener: (info: { mac: string }) => void): this;
  on(event: "deviceUnsupported", listener: (info: { mac: string; version: number }) => void): this;
  on(event: "status", listener: (status: UsbStatus) => void): this;
  on(event: "log", listener: (entry: { mac: string; level: "info" | "warn" | "error"; text: string }) => void): this;
  on(event: "unflashed", listener: (info: { port: string }) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class UsbTransport extends EventEmitter {
  readonly #bridge: UsbBridgePort;
  /** MACs currently connected over USB → their reported protocol version. */
  readonly #online = new Map<string, number>();

  constructor(bridge: UsbBridgePort) {
    super();
    this.#bridge = bridge;
    this.#bridge.on("usb", (message) => this.#onUsb(message));
  }

  // The shell owns the port lifecycle, so these are no-ops — present to satisfy DeviceServerPort.
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  /** MACs of devices currently reachable over USB (used by the composite for dedup). */
  connectedMacs(): string[] {
    return [...this.#online.keys()];
  }

  has(mac: string): boolean {
    return this.#online.has(mac);
  }

  // ── Outbound (host → device) ───────────────────────────────────────────────────

  sendColor(mac: string, color: Color, brightness: number): boolean {
    return this.#send(mac, setColorPayload(color, brightness));
  }

  /** Provision WiFi creds and kick off a validating join (USB only). */
  provisionWifi(mac: string, ssid: string, password: string): boolean {
    return this.#send(mac, setWifiPayload(ssid, password));
  }

  /** Set the device's unplugged transport mode (a {@link Transport} value). */
  setTransport(mac: string, mode: number): boolean {
    return this.#send(mac, setTransportPayload(mode));
  }

  /** Ask the device for a fresh STATUS frame. */
  requestStatus(mac: string): boolean {
    return this.#send(mac, getStatusPayload());
  }

  #send(mac: string, payload: Uint8Array): boolean {
    if (!this.#online.has(mac)) return false;
    this.#bridge.sendUsb({ type: "usbSend", mac, payloadHex: toHex(payload) });
    return true;
  }

  // ── Inbound (device → host) ─────────────────────────────────────────────────────

  #onUsb(message: UsbInbound): void {
    switch (message.type) {
      case "usbDeviceConnected": {
        this.#online.set(message.mac, message.version);
        if (!isSupportedVersion(message.version)) {
          this.emit("deviceUnsupported", { mac: message.mac, version: message.version });
        }
        this.emit("deviceConnected", { mac: message.mac, version: message.version });
        break;
      }
      case "usbDeviceDisconnected": {
        this.#online.delete(message.mac);
        this.emit("deviceDisconnected", { mac: message.mac });
        break;
      }
      case "unflashedDeviceDetected": {
        this.emit("unflashed", { port: message.port });
        break;
      }
      case "usbFrame": {
        this.#onFrame(message);
        break;
      }
    }
  }

  #onFrame(frame: Extract<UsbInbound, { type: "usbFrame" }>): void {
    let decoded;
    try {
      decoded = decodeUsbFrame(frame);
    } catch (err) {
      this.emit("error", err as Error); // bad frame; the shell already resynced past it
      return;
    }
    if (decoded.kind === "status") {
      this.emit("status", {
        mac: frame.mac,
        mode: decoded.transport,
        wifiState: WIFI_STATE_NAME[decoded.wifiState] ?? "idle",
        rssi: decoded.rssi === 0 ? null : decoded.rssi,
        ssid: decoded.ssid,
      });
    } else if (decoded.kind === "log") {
      this.emit("log", { mac: frame.mac, level: LOG_LEVEL_NAME[decoded.level] ?? "info", text: decoded.text });
    }
    // HELLO/HEARTBEAT over USB need no handling here (the shell turns HELLO into usbDeviceConnected).
  }
}

/** Map a UI transport-mode string to its wire {@link Transport} value. */
export function transportModeValue(mode: "notx" | "wifi"): number {
  return mode === "notx" ? Transport.NOTX : Transport.WIFI;
}

/**
 * Map a device's reported wire transport byte to the UI's provisioned-mode name — what the
 * device does when unplugged. `null` for any value we don't recognise (e.g. a future mode an
 * older sidecar doesn't model), so the wizard shows "unprovisioned" rather than a wrong mode.
 */
export function provisionedModeName(mode: number): "wifi" | "notx" | null {
  return mode === Transport.WIFI ? "wifi" : mode === Transport.NOTX ? "notx" : null;
}

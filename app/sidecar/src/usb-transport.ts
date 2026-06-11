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
  ESPNOW_CHANNEL,
  Transport,
  WifiState,
  getStatusPayload,
  isSupportedVersion,
  setBridgePayload,
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
  /** The device's stored ESP-NOW channel, or null when the device reports none (pre-v3 firmware). */
  channel: number | null;
  /**
   * True while the device confirms it is in bridge mode (STATUS `[bridging]` byte). The host
   * uses it to confirm `SET_BRIDGE 1` took effect; absent on older firmware → false.
   */
  bridge: boolean;
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
  /**
   * An ESP-NOW frame a bridge received and forwarded up (RELAY envelope). `bridgeMac` is the
   * USB device the frame arrived on; `inner` is an unframed device→server payload the
   * {@link EspNowTransport} runs back through `decodeDeviceMessage`.
   */
  on(event: "relayed", listener: (info: { bridgeMac: string; srcMac: string; inner: Uint8Array }) => void): this;
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

  /**
   * Set the device's unplugged transport mode (a {@link Transport} value). ESP-NOW also carries
   * the channel byte ({@link ESPNOW_CHANNEL}); No-TX/WiFi send the bare `[type][mode]`.
   */
  setTransport(mac: string, mode: number): boolean {
    const channel = mode === Transport.ESPNOW ? ESPNOW_CHANNEL : undefined;
    return this.#send(mac, setTransportPayload(mode, channel));
  }

  /**
   * Enter (or leave) ESP-NOW bridge mode. Runtime-only on the device — the sidecar persists the
   * designation and re-asserts it on every USB (re)connect (see {@link SidecarApp}). Sent only to
   * version ≥ 3 devices by the caller; the device confirms via the STATUS `bridging` byte.
   */
  setBridge(mac: string, enabled: boolean): boolean {
    return this.#send(mac, setBridgePayload(enabled, ESPNOW_CHANNEL));
  }

  /** Ask the device for a fresh STATUS frame. */
  requestStatus(mac: string): boolean {
    return this.#send(mac, getStatusPayload());
  }

  /**
   * Send a pre-built RELAY payload (`relayPayload(targetMac, inner)`) to a connected bridge over
   * USB. The {@link EspNowTransport} builds the envelope; this is just the online-guarded write to
   * the bridge's cable. Returns false when the bridge isn't on USB.
   */
  sendBridgeRelay(bridgeMac: string, relayFramePayload: Uint8Array): boolean {
    return this.#send(bridgeMac, relayFramePayload);
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
        channel: decoded.channel,
        bridge: decoded.bridge,
      });
    } else if (decoded.kind === "log") {
      this.emit("log", { mac: frame.mac, level: LOG_LEVEL_NAME[decoded.level] ?? "info", text: decoded.text });
    } else if (decoded.kind === "relayed") {
      // A bridge unwrapped a peer's ESP-NOW frame and forwarded it up. The bridge MAC is the USB
      // device the frame arrived on; the EspNowTransport decodes `inner` itself (the envelope is
      // the only layer the bridge adds), so we just re-emit rather than dispatch here.
      this.emit("relayed", { bridgeMac: frame.mac, srcMac: decoded.srcMac, inner: decoded.inner });
    }
    // HELLO/HEARTBEAT over USB need no handling here (the shell turns HELLO into usbDeviceConnected).
  }
}

/** Map a UI transport-mode string to its wire {@link Transport} value. */
export function transportModeValue(mode: "notx" | "wifi" | "espnow"): number {
  switch (mode) {
    case "notx":
      return Transport.NOTX;
    case "wifi":
      return Transport.WIFI;
    case "espnow":
      return Transport.ESPNOW;
  }
}

/**
 * Map a device's reported wire transport byte to the UI's provisioned-mode name — what the
 * device does when unplugged. `null` for any value we don't recognise (e.g. a future mode an
 * older sidecar doesn't model), so the wizard shows "unprovisioned" rather than a wrong mode.
 */
export function provisionedModeName(mode: number): "wifi" | "notx" | "espnow" | null {
  return mode === Transport.WIFI
    ? "wifi"
    : mode === Transport.NOTX
      ? "notx"
      : mode === Transport.ESPNOW
        ? "espnow"
        : null;
}

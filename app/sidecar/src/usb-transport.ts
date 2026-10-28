/**
 * The USB transport — a thin proxy that makes a USB-cabled device look exactly like a
 * TCP one to the orchestrator. The Tauri shell owns the serial port; this class rides
 * the shell↔sidecar bridge (`usb-bridge.ts`):
 *
 *   • inbound  `usbDeviceConnected/Disconnected` → the `deviceConnected/deviceDisconnected`
 *     events the orchestrator already consumes (so it stays transport-agnostic);
 *   • inbound  `usbFrame` → decoded STATUS/LOG → `status`/`log` events (provisioning UX);
 *   • outbound `sendColor`/`provisionWifi`/`setTransport` → a `usbSend` with the
 *     payload built by the shared `protocol.ts` codecs and hex-wrapped for the bridge;
 *   • `scanWifi` → SCAN_WIFI out, and the SCAN_RESULT frames that answer it collected into one
 *     access-point list.
 *
 * SET_COLOR is byte-identical to TCP — literally the same payload builder — so a USB
 * device renders the same palette/animation frames (including the locate strobe) the
 * server streams.
 */

import { EventEmitter } from "node:events";

import { type DeviceTransportEvents, announceDevice } from "./device-events.ts";
import type { DeviceWifiState, TransportMode } from "./ipc.ts";
import {
  type Color,
  type ScanResultMessage,
  type ScannedAccessPoint,
  Transport,
  WifiState,
  getStatusPayload,
  logLevelName,
  scanWifiPayload,
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
  /** Null for a state byte this sidecar doesn't know (newer firmware). */
  wifiState: DeviceWifiState | null;
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

/**
 * How long a scan may take, from SCAN_WIFI out to its last SCAN_RESULT in. The device needs up to
 * about 3.5 s to start and finish the scan, plus about 0.5 s to send 255 frames; a failed scan
 * sends no frames at all (only an ERROR LOG), so this timeout is how the host learns of it.
 */
export const WIFI_SCAN_TIMEOUT_MS = 10_000;

export interface UsbTransportOptions {
  /** Override {@link WIFI_SCAN_TIMEOUT_MS} (tests). */
  scanTimeoutMs?: number;
}

/** A SCAN_WIFI in flight on one device: the frames so far and how to settle its promise. */
interface PendingScan {
  promise: Promise<ScannedAccessPoint[]>;
  accessPoints: ScannedAccessPoint[];
  /** The frame count the first frame announced, or null before it arrives. */
  total: number | null;
  resolve(accessPoints: ScannedAccessPoint[]): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const WIFI_STATE_NAME: Record<number, DeviceWifiState> = {
  [WifiState.IDLE]: "idle",
  [WifiState.JOINING]: "joining",
  [WifiState.CONNECTED]: "connected",
  [WifiState.FAILED]: "failed",
};

/** The shared device events, plus the USB-only STATUS push and the ESP-NOW bridge's relayed frames. */
export interface UsbTransportEvents extends DeviceTransportEvents {
  status: [status: UsbStatus];
  /**
   * An ESP-NOW frame a bridge received and forwarded up (RELAY envelope). `bridgeMac` is the
   * USB device the frame arrived on; `inner` is an unframed device→server payload the
   * {@link EspNowTransport} runs back through `decodeDeviceMessage`.
   */
  relayed: [info: { bridgeMac: string; srcMac: string; inner: Uint8Array }];
}

// Typed events (the interface merges with the class and is erased at build).
export interface UsbTransport {
  on<K extends keyof UsbTransportEvents>(event: K, listener: (...args: UsbTransportEvents[K]) => void): this;
  emit<K extends keyof UsbTransportEvents>(event: K, ...args: UsbTransportEvents[K]): boolean;
}

export class UsbTransport extends EventEmitter {
  readonly #bridge: UsbBridgePort;
  /** MACs currently connected over USB → their reported protocol version. */
  readonly #online = new Map<string, number>();
  /** Scans in flight, by MAC (at most one per device: the device ignores a second SCAN_WIFI). */
  readonly #scans = new Map<string, PendingScan>();
  readonly #scanTimeoutMs: number;

  constructor(bridge: UsbBridgePort, options: UsbTransportOptions = {}) {
    super();
    this.#bridge = bridge;
    this.#scanTimeoutMs = options.scanTimeoutMs ?? WIFI_SCAN_TIMEOUT_MS;
    this.#bridge.on("usb", (message) => this.#onUsb(message));
  }

  // The shell owns the port lifecycle, so these are no-ops — present to satisfy DeviceServerPort.
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  // ── Outbound (host → device) ───────────────────────────────────────────────────

  sendColor(mac: string, color: Color, brightness: number): boolean {
    return this.#send(mac, setColorPayload(color, brightness));
  }

  /** Provision WiFi creds and kick off a validating join (USB only). */
  provisionWifi(mac: string, ssid: string, password: string): boolean {
    return this.#send(mac, setWifiPayload(ssid, password));
  }

  /**
   * Set the device's unplugged transport mode (a {@link Transport} value). ESP-NOW carries the
   * channel byte, so the caller must pass the session channel (the encoder throws without one);
   * No-TX/WiFi pass null and send the bare `[type][mode]`.
   */
  setTransport(mac: string, mode: number, channel: number | null): boolean {
    return this.#send(mac, setTransportPayload(mode, mode === Transport.ESPNOW ? (channel ?? undefined) : undefined));
  }

  /**
   * Enter (or leave) ESP-NOW bridge mode on `channel` (the session channel), at `txPower` quarter-dBm when given. Runtime-only on the device — the sidecar persists the
   * designation and re-asserts it on every USB (re)connect (see {@link SidecarApp}). The caller
   * sends it only to version ≥ 3 devices, and `txPower` only to version ≥ 4 ones; the device
   * confirms via the STATUS `bridging` byte.
   */
  setBridge(mac: string, enabled: boolean, channel: number, txPower?: number): boolean {
    return this.#send(mac, setBridgePayload(enabled, channel, txPower));
  }

  /** Ask the device for a fresh STATUS frame. */
  requestStatus(mac: string): boolean {
    return this.#send(mac, getStatusPayload());
  }

  /**
   * Ask the device to scan channels 1–13 for access points (SCAN_WIFI). Resolves with every access
   * point it heard (empty when it heard none) once the last SCAN_RESULT arrives; rejects when the
   * device doesn't finish within {@link WIFI_SCAN_TIMEOUT_MS} (a failed scan sends nothing), when
   * its frames don't run 0 … total - 1 in order, or when it leaves USB first. A call while that
   * device's scan is still running joins it rather than sending a second SCAN_WIFI. Returns null
   * when the device isn't on USB. The caller sends it only to version ≥ 4 devices.
   */
  scanWifi(mac: string): Promise<ScannedAccessPoint[]> | null {
    const running = this.#scans.get(mac);
    if (running) return running.promise;
    if (!this.#send(mac, scanWifiPayload())) return null;
    let resolve!: (accessPoints: ScannedAccessPoint[]) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<ScannedAccessPoint[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(
      () => this.#failScan(mac, new Error(`no complete scan result within ${this.#scanTimeoutMs / 1000} s`)),
      this.#scanTimeoutMs,
    );
    this.#scans.set(mac, { promise, accessPoints: [], total: null, resolve, reject, timer });
    return promise;
  }

  /** Fold one SCAN_RESULT frame into the device's scan in flight; frames nobody asked for are dropped. */
  #onScanResult(mac: string, frame: ScanResultMessage): void {
    const scan = this.#scans.get(mac);
    if (!scan) return;
    const expected = scan.accessPoints.length;
    if (frame.index !== expected || (scan.total !== null && frame.total !== scan.total)) {
      this.#failScan(mac, new Error(`scan result frame ${frame.index}/${frame.total} arrived out of order`));
      return;
    }
    scan.total = frame.total;
    if (frame.ap) scan.accessPoints.push(frame.ap);
    // The empty frame (total 0) is the whole answer: scanned and heard nothing.
    if (scan.accessPoints.length >= frame.total) {
      clearTimeout(scan.timer);
      this.#scans.delete(mac);
      scan.resolve(scan.accessPoints);
    }
  }

  #failScan(mac: string, err: Error): void {
    const scan = this.#scans.get(mac);
    if (!scan) return;
    clearTimeout(scan.timer);
    this.#scans.delete(mac);
    scan.reject(err);
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
        announceDevice(this, message.mac, message.version);
        break;
      }
      case "usbDeviceDisconnected": {
        this.#online.delete(message.mac);
        this.#failScan(message.mac, new Error("it was unplugged before the scan finished"));
        this.emit("deviceDisconnected", { mac: message.mac });
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
        // A state byte this sidecar doesn't know (newer firmware) is unknown, not a confident "idle".
        wifiState: WIFI_STATE_NAME[decoded.wifiState] ?? null,
        rssi: decoded.rssi === 0 ? null : decoded.rssi,
        ssid: decoded.ssid,
        channel: decoded.channel,
        bridge: decoded.bridge,
      });
    } else if (decoded.kind === "firmware") {
      // Only from a device we hold, as on TCP and ESP-NOW: a frame that outlives its disconnect
      // mustn't record firmware for a light that is no longer here.
      if (this.#online.has(frame.mac)) this.emit("firmware", { mac: frame.mac, version: decoded.version });
    } else if (decoded.kind === "log") {
      this.emit("log", { mac: frame.mac, level: logLevelName(decoded.level), text: decoded.text });
    } else if (decoded.kind === "relayed") {
      // A bridge unwrapped a peer's ESP-NOW frame and forwarded it up. The bridge MAC is the USB
      // device the frame arrived on; the EspNowTransport decodes `inner` itself (the envelope is
      // the only layer the bridge adds), so we just re-emit rather than dispatch here.
      this.emit("relayed", { bridgeMac: frame.mac, srcMac: decoded.srcMac, inner: decoded.inner });
    } else if (decoded.kind === "scanResult") {
      this.#onScanResult(frame.mac, decoded);
    }
    // HELLO/HEARTBEAT over USB need no handling here (the shell turns HELLO into usbDeviceConnected).
  }
}

/** Map a UI transport-mode string to its wire {@link Transport} value. */
export function transportModeValue(mode: TransportMode): number {
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
export function provisionedModeName(mode: number): TransportMode | null {
  return mode === Transport.WIFI
    ? "wifi"
    : mode === Transport.NOTX
      ? "notx"
      : mode === Transport.ESPNOW
        ? "espnow"
        : null;
}

/**
 * The device side of the sidecar: the TCP server devices connect to, and the UDP
 * discovery that lets them find it without a hardcoded IP (docs/architecture.md
 * "Discovery Protocol", "TCP Connection").
 *
 * Devices are the TCP *clients*; this is the stable endpoint they dial. On connect
 * a device sends HELLO (its MAC + protocol version); the socket then *is* that
 * device's identity for the rest of the session, so HEARTBEATs carry no MAC. The
 * server resets a per-device timeout on every message and drops a device that goes
 * quiet. Reconnects re-send HELLO; a fresh socket for a known MAC replaces the old.
 *
 * This module owns sockets and framing only — it knows nothing about tally or the
 * ATEM. It emits connection lifecycle events and exposes `sendColor`
 * for the orchestrator (`src/app.ts`) to route outgoing commands by MAC.
 */

import { EventEmitter } from "node:events";
import { type AddressInfo, type Server, type Socket, createServer } from "node:net";
import { type Socket as UdpSocket, createSocket } from "node:dgram";

import { type DeviceTransportEvents, announceDevice, seconds } from "./device-events.ts";
import {
  ANNOUNCE_INTERVAL_MS,
  type Color,
  DISCOVERY_PORT,
  HEARTBEAT_TIMEOUT_MS,
  FrameDecoder,
  SERVER_PORT,
  encodeDiscoveryResponse,
  encodeSetColor,
  isDiscoveryRequest,
  decodeDeviceMessage,
} from "./protocol.ts";

export interface DeviceServerOptions {
  /** TCP port devices connect to (default {@link SERVER_PORT}; 0 picks a free one). */
  tcpPort?: number;
  /** UDP discovery port (default {@link DISCOVERY_PORT}; 0 picks a free one). */
  discoveryPort?: number;
  /** Bind address for both sockets (default all interfaces). */
  host?: string;
  /** Where presence is broadcast (default the IPv4 broadcast address). */
  broadcastAddress?: string;
  /** Per-device silence tolerated before the connection is dropped. */
  heartbeatTimeoutMs?: number;
  /** Presence-broadcast cadence. */
  announceIntervalMs?: number;
}

/** One device's live TCP session, before and after it identifies via HELLO. */
interface Connection {
  socket: Socket;
  decoder: FrameDecoder;
  /** The device's MAC once HELLO has arrived; null until then. */
  mac: string | null;
  /** Reset on every message; firing closes the socket. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The shared device events, plus `listening` once both sockets are bound. A TCP device has no LOG
 * frame, so `log` carries only the server's own notes on a device (an expired connection).
 */
export interface DeviceServerEvents extends DeviceTransportEvents {
  listening: [];
}

// Typed events (the interface merges with the class and is erased at build).
export interface DeviceServer {
  on<K extends keyof DeviceServerEvents>(event: K, listener: (...args: DeviceServerEvents[K]) => void): this;
  emit<K extends keyof DeviceServerEvents>(event: K, ...args: DeviceServerEvents[K]): boolean;
}

export class DeviceServer extends EventEmitter {
  readonly #host: string;
  readonly #wantedTcpPort: number;
  readonly #wantedDiscoveryPort: number;
  readonly #broadcastAddress: string;
  readonly #heartbeatTimeoutMs: number;
  readonly #announceIntervalMs: number;

  readonly #tcp: Server;
  #udp: UdpSocket | null = null;
  #announceTimer: ReturnType<typeof setInterval> | null = null;

  /** Every open socket (identified or not) — closed wholesale on stop. */
  readonly #connections = new Set<Connection>();
  /** The current connection for each identified MAC. */
  readonly #byMac = new Map<string, Connection>();

  constructor(options: DeviceServerOptions = {}) {
    super();
    this.#host = options.host ?? "0.0.0.0";
    this.#wantedTcpPort = options.tcpPort ?? SERVER_PORT;
    this.#wantedDiscoveryPort = options.discoveryPort ?? DISCOVERY_PORT;
    this.#broadcastAddress = options.broadcastAddress ?? "255.255.255.255";
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.#announceIntervalMs = options.announceIntervalMs ?? ANNOUNCE_INTERVAL_MS;

    this.#tcp = createServer((socket) => this.#accept(socket));
    this.#tcp.on("error", (err) => this.emit("error", err));
  }

  /** The actual TCP port in use (resolves a 0 / ephemeral port to its real value). */
  get tcpPort(): number {
    const address = this.#tcp.address();
    return address && typeof address === "object" ? (address as AddressInfo).port : this.#wantedTcpPort;
  }

  /** The actual UDP discovery port in use. */
  get discoveryPort(): number {
    const address = this.#udp?.address();
    return address ? address.port : this.#wantedDiscoveryPort;
  }

  /** Bind the TCP server and the UDP discovery socket, and start announcing. */
  async start(): Promise<void> {
    await Promise.all([this.#startTcp(), this.#startDiscovery()]);
    this.emit("listening");
  }

  /** Close everything: stop accepting, drop every socket, stop discovery. */
  async stop(): Promise<void> {
    if (this.#announceTimer) clearInterval(this.#announceTimer);
    this.#announceTimer = null;
    for (const connection of [...this.#connections]) {
      this.#clearTimer(connection);
      connection.socket.destroy();
    }
    this.#connections.clear();
    this.#byMac.clear();
    await Promise.all([
      new Promise<void>((resolve) => this.#tcp.close(() => resolve())),
      this.#udp ? new Promise<void>((resolve) => this.#udp!.close(() => resolve())) : Promise.resolve(),
    ]);
    this.#udp = null;
  }

  // ── Outgoing commands ──────────────────────────────────────────────────────

  /** Send SET_COLOR to one device. Returns false if it isn't connected. */
  sendColor(mac: string, color: Color, brightness: number): boolean {
    return this.#write(mac, encodeSetColor(color, brightness));
  }

  #write(mac: string, frame: Uint8Array): boolean {
    const connection = this.#byMac.get(mac);
    if (!connection || connection.socket.readyState !== "open") return false;
    try {
      connection.socket.write(frame);
      return true;
    } catch (err) {
      this.emit("error", err as Error);
      return false;
    }
  }

  // ── TCP ──────────────────────────────────────────────────────────────────────

  #startTcp(): Promise<void> {
    return new Promise((resolve) => {
      this.#tcp.listen(this.#wantedTcpPort, this.#host, () => resolve());
    });
  }

  #accept(socket: Socket): void {
    const connection: Connection = { socket, decoder: new FrameDecoder(), mac: null, timer: null };
    this.#connections.add(connection);
    this.#armTimer(connection); // a socket that never says HELLO still ages out

    socket.on("data", (chunk: Uint8Array) => this.#onData(connection, chunk));
    socket.on("error", () => {
      /* surfaced as a 'close'; nothing actionable here */
    });
    socket.on("close", () => this.#onClose(connection));
  }

  #onData(connection: Connection, chunk: Uint8Array): void {
    let payloads: Uint8Array[];
    try {
      payloads = connection.decoder.push(chunk);
    } catch (err) {
      this.emit("error", err as Error);
      return;
    }
    for (const payload of payloads) {
      let message;
      try {
        message = decodeDeviceMessage(payload);
      } catch (err) {
        this.emit("error", err as Error); // skip the bad frame; framing resyncs at the next
        continue;
      }
      this.#armTimer(connection); // any valid message proves the device is alive
      if (message.kind === "hello") this.#onHello(connection, message.mac, message.version);
      else if (message.kind === "firmware" && connection.mac) {
        this.emit("firmware", { mac: connection.mac, version: message.version });
      }
      // HEARTBEAT needs no handling beyond the timer reset above.
    }
  }

  #onHello(connection: Connection, mac: string, version: number): void {
    // A new socket for a MAC we already track is a reconnect — retire the stale one.
    const existing = this.#byMac.get(mac);
    if (existing && existing !== connection) {
      this.#byMac.delete(mac); // so the old socket's close is treated as stale, not a disconnect
      existing.socket.destroy();
    }
    connection.mac = mac;
    this.#byMac.set(mac, connection);

    announceDevice(this, mac, version);
  }

  #onClose(connection: Connection): void {
    this.#clearTimer(connection);
    this.#connections.delete(connection);
    const mac = connection.mac;
    // Only emit a disconnect if this socket is still the live one for its MAC; a
    // socket replaced by a reconnect was already removed from the map above.
    if (mac !== null && this.#byMac.get(mac) === connection) {
      this.#byMac.delete(mac);
      this.emit("deviceDisconnected", { mac });
    }
  }

  #armTimer(connection: Connection): void {
    this.#clearTimer(connection);
    connection.timer = setTimeout(() => this.#expire(connection), this.#heartbeatTimeoutMs);
    connection.timer.unref();
  }

  /**
   * Drop a connection that went silent past the timeout. Its `close` then emits the disconnect; a
   * socket that never said HELLO has no device to note it against, so it goes quietly.
   */
  #expire(connection: Connection): void {
    const mac = connection.mac;
    if (mac !== null && this.#byMac.get(mac) === connection) {
      const timeout = seconds(this.#heartbeatTimeoutMs);
      this.emit("log", { mac, level: "warn", text: `TCP light ${mac} expired: silent for ${timeout}` });
    }
    connection.socket.destroy();
  }

  #clearTimer(connection: Connection): void {
    if (connection.timer) {
      clearTimeout(connection.timer);
      connection.timer = null;
    }
  }

  // ── UDP discovery ──────────────────────────────────────────────────────────────

  #startDiscovery(): Promise<void> {
    return new Promise((resolve, reject) => {
      const udp = createSocket({ type: "udp4", reuseAddr: true });
      this.#udp = udp;
      udp.on("error", (err) => this.emit("error", err));
      udp.on("message", (data, rinfo) => {
        if (!isDiscoveryRequest(data.toString("utf8"))) return;
        // Unicast our TCP port straight back to the asking device.
        udp.send(encodeDiscoveryResponse(this.tcpPort), rinfo.port, rinfo.address, (err) => {
          if (err) this.emit("error", err);
        });
      });
      udp.once("error", reject);
      udp.bind(this.#wantedDiscoveryPort, this.#host, () => {
        udp.removeListener("error", reject);
        try {
          udp.setBroadcast(true);
        } catch {
          // Some stacks forbid broadcast; unicast replies to TALLY_FIND still work.
        }
        this.#announceTimer = setInterval(() => this.#announce(), this.#announceIntervalMs);
        this.#announceTimer.unref();
        resolve();
      });
    });
  }

  /**
   * Broadcast presence so devices that start before us eventually find us. Devices
   * listen on the fixed discovery port, so we announce to that. With an ephemeral
   * bind (port 0, used in tests) there is no fixed port to reach, so we skip it —
   * unicast replies to TALLY_FIND still work.
   */
  #announce(): void {
    if (this.#wantedDiscoveryPort <= 0) return;
    this.#udp?.send(
      encodeDiscoveryResponse(this.tcpPort),
      this.#wantedDiscoveryPort,
      this.#broadcastAddress,
      (err) => {
        if (err) this.emit("error", err);
      },
    );
  }
}

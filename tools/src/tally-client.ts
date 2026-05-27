/**
 * Tally client simulator — a hardware-free stand-in for an ESP32 tally device.
 *
 * It does what the firmware does on the wire (Phase 3): discover the server over
 * UDP, open a TCP connection, send HELLO then periodic HEARTBEATs, and act on the
 * SET_COLOR / IDENTIFY commands the server sends back. That lets the whole
 * server-side path — discovery, the TCP server, the tally engine — be exercised
 * without an ESP32 on the bench.
 *
 * This module is the reusable core (a single device session + the discovery
 * helper); `tally-client-cli.ts` wraps it in a runnable command with logging,
 * reconnection, and multi-device spawning.
 */

import { EventEmitter } from "node:events";
import { type Socket, createConnection } from "node:net";
import { createSocket } from "node:dgram";

import {
  type Color,
  DISCOVERY_PORT,
  DISCOVERY_REQUEST,
  PROTOCOL_VERSION,
  parseDiscoveryResponse,
} from "../../app/sidecar/src/protocol.ts";
import {
  FrameDecoder,
  decodeServerMessage,
  encodeHeartbeat,
  encodeHello,
} from "./device-protocol.ts";

/** How often a device heartbeats once connected (ARCHITECTURE.md: every 10s). */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** How often a device re-broadcasts its discovery request until it finds a server. */
export const DISCOVERY_INTERVAL_MS = 2_000;

// ── A single device's TCP session ───────────────────────────────────────────────

export interface TallyClientOptions {
  /** The device's identity, colon-form MAC (e.g. "aa:bb:cc:dd:ee:ff"). */
  mac: string;
  /** Protocol version this device claims to speak (default: the current version). */
  version?: number;
  /** Heartbeat cadence; lower values are useful in tests. */
  heartbeatIntervalMs?: number;
}

// Typed events (the interface merges with the class below and is erased at build).
export interface TallyClient {
  on(event: "connected", listener: () => void): this;
  on(event: "disconnected", listener: (hadError: boolean) => void): this;
  on(event: "setColor", listener: (color: Color, brightness: number) => void): this;
  on(event: "identify", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  emit(event: "connected"): boolean;
  emit(event: "disconnected", hadError: boolean): boolean;
  emit(event: "setColor", color: Color, brightness: number): boolean;
  emit(event: "identify"): boolean;
  emit(event: "error", err: Error): boolean;
}

/**
 * One device's connection to the server. Open it with {@link connect}; it sends
 * HELLO, heartbeats on its interval, and emits `setColor` / `identify` for the
 * commands it receives. It does **not** reconnect on its own — that policy lives
 * in the CLI — so the session stays simple and easy to test.
 */
export class TallyClient extends EventEmitter {
  readonly mac: string;
  readonly version: number;
  readonly #heartbeatIntervalMs: number;
  #socket: Socket | null = null;
  #decoder = new FrameDecoder();
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #heartbeatsEnabled = true;

  constructor(options: TallyClientOptions) {
    super();
    this.mac = options.mac;
    this.version = options.version ?? PROTOCOL_VERSION.CURRENT;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === "open";
  }

  /** Open a TCP connection to the server and begin the HELLO/heartbeat protocol. */
  connect(host: string, port: number): void {
    if (this.#socket) throw new Error("already connected — call close() first");
    this.#decoder = new FrameDecoder();
    const socket = createConnection({ host, port });
    this.#socket = socket;

    socket.on("connect", () => {
      socket.write(encodeHello(this.mac, this.version));
      this.#startHeartbeat();
      this.emit("connected");
    });
    socket.on("data", (chunk: Uint8Array) => this.#onData(chunk));
    socket.on("error", (err) => this.emit("error", err));
    socket.on("close", (hadError) => {
      this.#stopHeartbeat();
      this.#socket = null;
      this.emit("disconnected", hadError);
    });
  }

  /** Close the connection. A `disconnected` event follows once the socket is down. */
  close(): void {
    this.#stopHeartbeat();
    const socket = this.#socket;
    this.#socket = null;
    socket?.destroy();
  }

  /**
   * Stop or resume sending heartbeats without dropping the connection — used to
   * simulate a wedged device so the server's heartbeat-timeout path can be tested.
   */
  setHeartbeatsEnabled(enabled: boolean): void {
    this.#heartbeatsEnabled = enabled;
  }

  #onData(chunk: Uint8Array): void {
    for (const payload of this.#decoder.push(chunk)) {
      let message;
      try {
        message = decodeServerMessage(payload);
      } catch (err) {
        this.emit("error", err as Error);
        continue;
      }
      if (message.kind === "setColor") this.emit("setColor", message.color, message.brightness);
      else this.emit("identify");
    }
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#heartbeatsEnabled && this.#socket?.readyState === "open") {
        this.#socket.write(encodeHeartbeat());
      }
    }, this.#heartbeatIntervalMs);
    // Don't let the heartbeat timer alone keep the process (or a test) alive.
    this.#heartbeatTimer.unref();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }
}

// ── UDP discovery ────────────────────────────────────────────────────────────────

export interface DiscoverOptions {
  /** UDP port the request is sent to (default: the discovery port, 7001). */
  requestPort?: number;
  /** Where to broadcast the request (default: the IPv4 broadcast address). */
  broadcastAddress?: string;
  /** How often to re-broadcast until a reply arrives (default: 2s). */
  broadcastIntervalMs?: number;
  /** Aborts the search; the returned promise rejects with the abort reason. */
  signal?: AbortSignal;
  /** Called before each broadcast — handy for a "still searching" log line. */
  onAttempt?: () => void;
}

/**
 * Broadcast `TALLY_FIND` until the server answers with `TALLY_HERE:<port>`, then
 * resolve to the server's address and advertised TCP port. The request is re-sent
 * on an interval so discovery is startup-order independent: a device started
 * before the server keeps trying until the server is reachable.
 */
export function discoverServer(
  options: DiscoverOptions = {},
): Promise<{ host: string; port: number }> {
  const requestPort = options.requestPort ?? DISCOVERY_PORT;
  const broadcastAddress = options.broadcastAddress ?? "255.255.255.255";
  const intervalMs = options.broadcastIntervalMs ?? DISCOVERY_INTERVAL_MS;
  const { signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }

    const socket = createSocket({ type: "udp4", reuseAddr: true });
    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (timer) clearInterval(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
      socket.close();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (result: { host: string; port: number }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = (): void =>
      fail((signal?.reason as Error) ?? new Error("discovery aborted"));

    socket.on("error", fail);
    socket.on("message", (data, rinfo) => {
      const parsed = parseDiscoveryResponse(data.toString("utf8"));
      if (parsed) succeed({ host: rinfo.address, port: parsed.port });
    });

    const broadcast = (): void => {
      options.onAttempt?.();
      socket.send(DISCOVERY_REQUEST, requestPort, broadcastAddress, (err) => {
        if (err) fail(err);
      });
    };

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        // Some stacks disallow it; the server's unicast reply still reaches us.
      }
      broadcast();
      timer = setInterval(broadcast, intervalMs);
      timer.unref();
    });

    signal?.addEventListener("abort", onAbort);
  });
}

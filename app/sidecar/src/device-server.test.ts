import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { type Socket, createConnection } from "node:net";
import { createSocket } from "node:dgram";

import { DeviceServer } from "./device-server.ts";
import {
  type Color,
  COLORS,
  DeviceMessageType,
  FrameDecoder,
  ServerMessageType,
  DISCOVERY_REQUEST,
  frame,
  parseDiscoveryResponse,
} from "./protocol.ts";

// ── Test helpers (the device half of the wire, kept sidecar-local) ───────────────

const LOCAL = "127.0.0.1";

/** Start a server on ephemeral ports, bound to loopback, with a captured error log. */
async function startServer(options: Parameters<typeof makeServer>[0] = {}): Promise<{
  server: DeviceServer;
  errors: Error[];
}> {
  const { server, errors } = makeServer(options);
  await server.start();
  return { server, errors };
}

function makeServer(options: { heartbeatTimeoutMs?: number } = {}): { server: DeviceServer; errors: Error[] } {
  const server = new DeviceServer({
    tcpPort: 0,
    discoveryPort: 0,
    host: LOCAL,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
  });
  const errors: Error[] = [];
  server.on("error", (err) => errors.push(err));
  return { server, errors };
}

function macToBytes(mac: string): number[] {
  return mac.split(":").map((octet) => Number.parseInt(octet, 16));
}

/** A HELLO frame as a device would send: [type][version][MAC×6]. */
function helloFrame(mac: string, version = 1): Uint8Array {
  return frame(Uint8Array.of(DeviceMessageType.HELLO, version, ...macToBytes(mac)));
}

const heartbeatFrame = (): Uint8Array => frame(Uint8Array.of(DeviceMessageType.HEARTBEAT));

interface ServerFrame {
  type: number;
  color?: Color;
  brightness?: number;
}

/** Decode the next server→device frame off a raw client socket. */
function nextServerFrame(socket: Socket): Promise<ServerFrame> {
  const decoder = new FrameDecoder();
  return new Promise((resolve) => {
    const onData = (chunk: Uint8Array): void => {
      for (const payload of decoder.push(chunk)) {
        socket.off("data", onData);
        if (payload[0] === ServerMessageType.SET_COLOR) {
          resolve({
            type: payload[0]!,
            color: { r: payload[1]!, g: payload[2]!, b: payload[3]! },
            brightness: payload[4]!,
          });
        } else {
          resolve({ type: payload[0]! });
        }
        return;
      }
    };
    socket.on("data", onData);
  });
}

/** Open a raw TCP client to the server. */
function connect(server: DeviceServer): Socket {
  return createConnection({ host: LOCAL, port: server.tcpPort });
}

// ── HELLO / identity ─────────────────────────────────────────────────────────

test("a HELLO registers the device by MAC, with its version", async () => {
  const { server } = await startServer();
  const socket = connect(server);
  try {
    const connected = once(server, "deviceConnected");
    socket.write(helloFrame("aa:bb:cc:dd:ee:ff", 1));
    const [info] = (await connected) as [{ mac: string; version: number }];
    assert.deepEqual(info, { mac: "aa:bb:cc:dd:ee:ff", version: 1 });
    assert.deepEqual(server.connectedMacs(), ["aa:bb:cc:dd:ee:ff"]);
  } finally {
    socket.destroy();
    await server.stop();
  }
});

test("a HELLO below the minimum version also fires deviceUnsupported", async () => {
  const { server } = await startServer();
  const socket = connect(server);
  try {
    const unsupported = once(server, "deviceUnsupported");
    socket.write(helloFrame("aa:bb:cc:dd:ee:ff", 0)); // below MIN_SUPPORTED (1)
    const [info] = (await unsupported) as [{ mac: string; version: number }];
    assert.deepEqual(info, { mac: "aa:bb:cc:dd:ee:ff", version: 0 });
    assert.deepEqual(server.connectedMacs(), ["aa:bb:cc:dd:ee:ff"], "it's still tracked, just flagged");
  } finally {
    socket.destroy();
    await server.stop();
  }
});

// ── Routing outgoing commands ────────────────────────────────────────────────

test("sendColor delivers a SET_COLOR to the addressed device", async () => {
  const { server } = await startServer();
  const socket = connect(server);
  try {
    const connected = once(server, "deviceConnected");
    socket.write(helloFrame("aa:bb:cc:dd:ee:ff"));
    await connected;

    const incoming = nextServerFrame(socket);
    assert.equal(server.sendColor("aa:bb:cc:dd:ee:ff", COLORS.live, 200), true);
    const received = await incoming;
    assert.equal(received.type, ServerMessageType.SET_COLOR);
    assert.deepEqual(received.color, COLORS.live);
    assert.equal(received.brightness, 200);
  } finally {
    socket.destroy();
    await server.stop();
  }
});

test("identify delivers an IDENTIFY to the addressed device", async () => {
  const { server } = await startServer();
  const socket = connect(server);
  try {
    const connected = once(server, "deviceConnected");
    socket.write(helloFrame("aa:bb:cc:dd:ee:ff"));
    await connected;

    const incoming = nextServerFrame(socket);
    assert.equal(server.identify("aa:bb:cc:dd:ee:ff"), true);
    assert.equal((await incoming).type, ServerMessageType.IDENTIFY);
  } finally {
    socket.destroy();
    await server.stop();
  }
});

test("sending to an unknown device returns false", async () => {
  const { server } = await startServer();
  try {
    assert.equal(server.sendColor("00:00:00:00:00:99", COLORS.idle, 128), false);
    assert.equal(server.identify("00:00:00:00:00:99"), false);
  } finally {
    await server.stop();
  }
});

// ── Heartbeat timeout ──────────────────────────────────────────────────────────

test("a device that goes silent past the timeout is dropped", async () => {
  const { server } = await startServer({ heartbeatTimeoutMs: 60 });
  const socket = connect(server);
  try {
    const connected = once(server, "deviceConnected");
    socket.write(helloFrame("aa:bb:cc:dd:ee:ff"));
    await connected;

    const disconnected = once(server, "deviceDisconnected");
    // Send nothing further: the per-device timer should fire and close the socket.
    const [info] = (await disconnected) as [{ mac: string }];
    assert.deepEqual(info, { mac: "aa:bb:cc:dd:ee:ff" });
    assert.deepEqual(server.connectedMacs(), []);
  } finally {
    socket.destroy();
    await server.stop();
  }
});

test("heartbeats keep a device alive past the timeout", async () => {
  const { server } = await startServer({ heartbeatTimeoutMs: 80 });
  const socket = connect(server);
  let disconnected = false;
  server.on("deviceDisconnected", () => {
    disconnected = true;
  });
  try {
    const connected = once(server, "deviceConnected");
    socket.write(helloFrame("aa:bb:cc:dd:ee:ff"));
    await connected;

    const beat = setInterval(() => socket.write(heartbeatFrame()), 30);
    await new Promise((resolve) => setTimeout(resolve, 250)); // ~3 timeouts' worth
    clearInterval(beat);
    assert.equal(disconnected, false, "regular heartbeats should keep the connection alive");
    assert.deepEqual(server.connectedMacs(), ["aa:bb:cc:dd:ee:ff"]);
  } finally {
    socket.destroy();
    await server.stop();
  }
});

// ── Reconnect replaces the stale socket ──────────────────────────────────────────

test("a reconnect for a known MAC replaces the old socket without a spurious disconnect", async () => {
  const { server } = await startServer();
  const first = connect(server);
  let disconnects = 0;
  server.on("deviceDisconnected", () => {
    disconnects++;
  });
  try {
    const firstConnected = once(server, "deviceConnected");
    first.write(helloFrame("aa:bb:cc:dd:ee:ff"));
    await firstConnected;

    // A second socket for the same MAC: the server should retire the first.
    const second = connect(server);
    const secondConnected = once(server, "deviceConnected");
    second.write(helloFrame("aa:bb:cc:dd:ee:ff"));
    await secondConnected;
    await once(first, "close"); // the old socket is destroyed by the server

    assert.deepEqual(server.connectedMacs(), ["aa:bb:cc:dd:ee:ff"], "still exactly one device");
    assert.equal(disconnects, 0, "replacing a stale socket is not a disconnect");

    // Commands now reach the live (second) socket.
    const incoming = nextServerFrame(second);
    assert.equal(server.sendColor("aa:bb:cc:dd:ee:ff", COLORS.preview, 128), true);
    assert.deepEqual((await incoming).color, COLORS.preview);
    second.destroy();
  } finally {
    first.destroy();
    await server.stop();
  }
});

// ── UDP discovery ──────────────────────────────────────────────────────────────

test("the server answers a TALLY_FIND with its TCP port", async () => {
  const { server } = await startServer();
  const client = createSocket("udp4");
  try {
    client.bind(0, LOCAL);
    await once(client, "listening");

    const reply = once(client, "message");
    client.send(DISCOVERY_REQUEST, server.discoveryPort, LOCAL);
    const [data] = (await reply) as [Buffer];
    assert.deepEqual(parseDiscoveryResponse(data.toString("utf8")), { port: server.tcpPort });
  } finally {
    client.close();
    await server.stop();
  }
});

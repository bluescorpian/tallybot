import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { type AddressInfo, type Server, type Socket, createServer } from "node:net";
import { createSocket } from "node:dgram";

// The server side of the protocol — what a real sidecar would use to read HELLO
// and HEARTBEAT and to encode the commands it sends back.
import {
  type DeviceMessage,
  COLORS,
  DISCOVERY_REQUEST,
  FrameDecoder,
  decodeDeviceMessage,
  encodeDiscoveryResponse,
  encodeIdentify,
  encodeSetColor,
} from "../../app/sidecar/src/protocol.ts";
import { randomMac } from "./device-protocol.ts";
import { TallyClient, discoverServer } from "./tally-client.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port };
}

/** Decode every device→server message arriving on a server-side socket. */
function onDeviceMessages(socket: Socket, handle: (message: DeviceMessage) => void): void {
  const decoder = new FrameDecoder();
  socket.on("data", (chunk: Uint8Array) => {
    for (const payload of decoder.push(chunk)) handle(decodeDeviceMessage(payload));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── TCP session ────────────────────────────────────────────────────────────────

test("on connect the client sends a HELLO carrying its MAC and version", async () => {
  const { server, port } = await startServer();
  const mac = "aa:bb:cc:dd:ee:ff";
  const client = new TallyClient({ mac, version: 1, heartbeatIntervalMs: 60_000 });

  const helloReceived = new Promise<DeviceMessage>((resolve) => {
    server.once("connection", (socket) => onDeviceMessages(socket, resolve));
  });

  try {
    client.connect("127.0.0.1", port);
    await once(client, "connected");
    assert.deepEqual(await helloReceived, { kind: "hello", version: 1, mac });
  } finally {
    client.close();
    server.close();
  }
});

test("the client decodes a SET_COLOR and emits setColor", async () => {
  const { server, port } = await startServer();
  const client = new TallyClient({ mac: randomMac(), heartbeatIntervalMs: 60_000 });

  try {
    const connection = once(server, "connection");
    client.connect("127.0.0.1", port);
    const [socket] = (await connection) as [Socket];
    await once(client, "connected");

    const setColor = once(client, "setColor");
    socket.write(encodeSetColor(COLORS.live, 200));
    const [color, brightness] = (await setColor) as [typeof COLORS.live, number];

    assert.deepEqual(color, { r: 255, g: 0, b: 0 });
    assert.equal(brightness, 200);
  } finally {
    client.close();
    server.close();
  }
});

test("the client decodes an IDENTIFY and emits identify", async () => {
  const { server, port } = await startServer();
  const client = new TallyClient({ mac: randomMac(), heartbeatIntervalMs: 60_000 });

  try {
    const connection = once(server, "connection");
    client.connect("127.0.0.1", port);
    const [socket] = (await connection) as [Socket];
    await once(client, "connected");

    const identify = once(client, "identify");
    socket.write(encodeIdentify());
    await identify; // resolves only if the client decoded IDENTIFY
  } finally {
    client.close();
    server.close();
  }
});

test("the client heartbeats on its interval and stops when silenced", async () => {
  const { server, port } = await startServer();
  const client = new TallyClient({ mac: randomMac(), heartbeatIntervalMs: 25 });
  let heartbeats = 0;
  server.once("connection", (socket) =>
    onDeviceMessages(socket, (message) => {
      if (message.kind === "heartbeat") heartbeats++;
    }),
  );

  try {
    client.connect("127.0.0.1", port);
    await once(client, "connected");

    await delay(120); // ~4 intervals
    assert.ok(heartbeats >= 2, `expected at least 2 heartbeats, got ${heartbeats}`);

    client.setHeartbeatsEnabled(false);
    const afterSilence = heartbeats;
    await delay(120);
    assert.equal(heartbeats, afterSilence, "no heartbeats should be sent while silenced");
  } finally {
    client.close();
    server.close();
  }
});

test("close emits disconnected", async () => {
  const { server, port } = await startServer();
  const client = new TallyClient({ mac: randomMac(), heartbeatIntervalMs: 60_000 });

  try {
    client.connect("127.0.0.1", port);
    await once(client, "connected");
    const disconnected = once(client, "disconnected");
    client.close();
    await disconnected;
    assert.equal(client.connected, false);
  } finally {
    server.close();
  }
});

// ── UDP discovery ────────────────────────────────────────────────────────────────

test("discoverServer resolves to a server that answers TALLY_FIND", async () => {
  // A stand-in for the sidecar's discovery responder: reply to each TALLY_FIND
  // with the advertised TCP port, unicast back to the sender.
  const responder = createSocket("udp4");
  responder.bind(0, "127.0.0.1");
  await once(responder, "listening");
  const responderPort = (responder.address() as AddressInfo).port;
  responder.on("message", (data, rinfo) => {
    if (data.toString("utf8") === DISCOVERY_REQUEST) {
      responder.send(encodeDiscoveryResponse(7000), rinfo.port, rinfo.address);
    }
  });

  try {
    const result = await discoverServer({
      broadcastAddress: "127.0.0.1",
      requestPort: responderPort,
      broadcastIntervalMs: 50,
    });
    assert.equal(result.host, "127.0.0.1");
    assert.equal(result.port, 7000);
  } finally {
    responder.close();
  }
});

test("discoverServer rejects when its signal is aborted", async () => {
  const controller = new AbortController();
  // Nothing answers on this port, so the only way out is the abort.
  const pending = discoverServer({
    broadcastAddress: "127.0.0.1",
    requestPort: 1,
    broadcastIntervalMs: 1_000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending);
});

/**
 * End-to-end integration: the real sidecar driven against the simulators, no hardware
 * in sight.
 *
 * The actual orchestrator, tally engine, device server, ATEM adapter, store and IPC bridge are
 * built by the same `createSidecar` composition root `main.ts` uses — only the real `Atem`
 * is swapped for the `FakeAtem`, most tests run the TCP transport alone (on ephemeral
 * ports; one runs main.ts's full transport set, playing the shell's USB messages), and real `TallyClient`s stand in for ESP32 devices over genuine TCP/UDP. We drive program/preview on the fake switcher and assign devices through
 * the IPC bridge, then assert the right colours actually reach the right clients on
 * the wire — and that assignments survive a restart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { FakeAtem } from "./atem-sim.ts";
import { TallyClient, discoverServer } from "./tally-client.ts";

import type { SidecarApp } from "../../app/sidecar/src/app.ts";
import { AtemSource } from "../../app/sidecar/src/atem.ts";
import type { DeviceServer } from "../../app/sidecar/src/device-server.ts";
import { ConfigStore } from "../../app/sidecar/src/store.ts";
import { IpcBridge } from "../../app/sidecar/src/ipc-bridge.ts";
import { createSidecar } from "../../app/sidecar/src/wiring.ts";
import {
  type AppState,
  type DeviceTransport,
  type SidecarEvent,
  type UiCommand,
  parseEvent,
  serializeMessage,
} from "../../app/sidecar/src/ipc.ts";
import {
  type Color,
  COLORS,
  DeviceMessageType,
  LogLevel,
  SETUP_COLOR,
  ServerMessageType,
  Transport,
  WifiState,
  parseMac,
} from "../../app/sidecar/src/protocol.ts";
import { type UsbInbound, type UsbSend, toHex } from "../../app/sidecar/src/usb-bridge.ts";

const LOCAL = "127.0.0.1";

interface Stack {
  app: SidecarApp;
  server: DeviceServer;
  atem: FakeAtem;
  /** The latest AppState the sidecar has emitted to the UI. */
  latestState: () => AppState | undefined;
  /** Every UI event the sidecar has emitted, in order. */
  events: SidecarEvent[];
  /** Every frame the sidecar has handed the shell to write to a USB device. */
  usbSends: UsbSend[];
  /** Send a UI command into the sidecar over the IPC bridge. */
  command: (command: UiCommand) => void;
  /** Send a shell→sidecar USB bridge message, as the Tauri shell would on the same stdin. */
  shell: (message: UsbInbound) => void;
  stop: () => Promise<void>;
}

/**
 * Build the sidecar through main.ts's `createSidecar` with the FakeAtem and ephemeral ports.
 * TCP-only unless `transports` says otherwise; `"default"` leaves it to createSidecar, as main.ts does.
 */
type TransportChoice = readonly DeviceTransport[] | "default";
async function buildStack(stateFile: string, transports: TransportChoice = ["wifi"]): Promise<Stack> {
  const store = await ConfigStore.load(stateFile);
  const atem = new FakeAtem({ inputCount: 4, programInput: 1, previewInput: 2 });
  const source = new AtemSource(atem);

  const input = new PassThrough();
  const output = new PassThrough();
  const ipc = new IpcBridge({ input, output });

  const states: AppState[] = [];
  const events: SidecarEvent[] = [];
  const usbSends: UsbSend[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const event = parseEvent(line);
      if (event) events.push(event);
      if (event?.type === "state") states.push(event.state);
      const usb = JSON.parse(line) as { type?: string };
      if (usb.type === "usbSend") usbSends.push(usb as UsbSend);
    }
  });

  const { app, tcp: server } = createSidecar({
    atem: source,
    ipc,
    store,
    log: () => {},
    scanNetwork: () => Promise.resolve([]), // no test scans; never open sockets on the LAN
    ...(transports === "default" ? {} : { transports }),
    tcp: { tcpPort: 0, discoveryPort: 0, host: LOCAL },
  });
  if (!server) throw new Error("the wifi transport is selected, so the TCP server exists");
  await app.start();

  return {
    app,
    server,
    atem,
    latestState: () => states.at(-1),
    events,
    usbSends,
    command: (command) => void input.write(serializeMessage(command)),
    shell: (message) => void input.write(`${JSON.stringify(message)}\n`),
    stop: () => app.stop(),
  };
}

/**
 * Bring the (fake) ATEM online via the same setSource path the settings UI uses. The sim has
 * no network, but setSource only accepts an IPv4 address, so this sends a documentation-range
 * one. The wait is bounded: a refused setSource fails here instead of hanging the run.
 */
async function connectSource(stack: Stack): Promise<void> {
  stack.command({ type: "setSource", ip: "192.0.2.1" });
  await once(stack.atem, "connected", { signal: AbortSignal.timeout(1500) });
}

/** Resolve with the next SET_COLOR a client receives that matches `predicate`. */
function nextColor(
  client: TallyClient,
  predicate: (color: Color) => boolean,
  timeoutMs = 1500,
): Promise<{ color: Color; brightness: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("setColor", onColor);
      reject(new Error("timed out waiting for the expected colour"));
    }, timeoutMs);
    const onColor = (color: Color, brightness: number): void => {
      if (!predicate(color)) return;
      clearTimeout(timer);
      client.off("setColor", onColor);
      resolve({ color, brightness });
    };
    client.on("setColor", onColor);
  });
}

const is = (want: Color) => (got: Color): boolean => got.r === want.r && got.g === want.g && got.b === want.b;

/** Poll until `probe` returns a value (not undefined), or fail naming what never arrived. */
async function eventually<T>(what: string, probe: () => T | undefined, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Run `body` against a fresh stack in a throwaway directory; always tear down. */
async function withStack(
  body: (stack: Stack, stateFile: string) => Promise<void>,
  transports?: TransportChoice,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tallybot-e2e-"));
  const stateFile = join(dir, "state.json");
  const stack = await buildStack(stateFile, transports);
  try {
    await body(stack, stateFile);
  } finally {
    await stack.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("a device discovers the server over UDP and connects over TCP", async () => {
  await withStack(async (stack) => {
    const found = await discoverServer({
      broadcastAddress: LOCAL,
      requestPort: stack.server.discoveryPort,
      broadcastIntervalMs: 50,
    });
    assert.equal(found.port, stack.server.tcpPort);

    const client = new TallyClient({ mac: "aa:bb:cc:dd:ee:01", heartbeatIntervalMs: 60_000 });
    try {
      const gotSetup = nextColor(client, is(SETUP_COLOR)); // unassigned → setup colour
      client.connect(found.host, found.port);
      await gotSetup;
      assert.deepEqual(stack.server.connectedMacs(), ["aa:bb:cc:dd:ee:01"]);
    } finally {
      client.close();
    }
  });
});

test("assigning a device drives its LED to the live colour; a program change moves it to idle", async () => {
  await withStack(async (stack) => {
    await connectSource(stack);
    const mac = "aa:bb:cc:dd:ee:02";
    const client = new TallyClient({ mac, heartbeatIntervalMs: 60_000 });
    try {
      const gotSetup = nextColor(client, is(SETUP_COLOR));
      client.connect(LOCAL, stack.server.tcpPort);
      await gotSetup;

      // Assign to input 1, which is on program → the device should go live (red).
      const gotLive = nextColor(client, is(COLORS.live));
      stack.command({ type: "assignDevice", mac, inputId: 1 });
      await gotLive;

      // Cut input 2 to air: input 1 is no longer live → the device drops to idle (green).
      const gotIdle = nextColor(client, is(COLORS.idle));
      await stack.atem.changeProgramInput(2);
      await gotIdle;

      assert.equal(stack.latestState()!.devices.find((d) => d.mac === mac)!.inputId, 1);
    } finally {
      client.close();
    }
  });
});

test("when the ATEM drops, the device flashes blue on the wire — never idle green", async () => {
  await withStack(async (stack) => {
    await connectSource(stack);
    const mac = "aa:bb:cc:dd:ee:0f";
    const client = new TallyClient({ mac, heartbeatIntervalMs: 60_000 });
    try {
      client.connect(LOCAL, stack.server.tcpPort);
      await once(client, "connected");
      stack.command({ type: "assignDevice", mac, inputId: 1 }); // on program → live
      await nextColor(client, is(COLORS.live));

      // The switcher disappears (a real network drop, not an orderly disconnect()).
      stack.atem.emit("disconnected");

      // The light must go to the blue fault and visibly blink (blue → off → blue),
      // and must never land on idle green while the source is untrustworthy.
      await nextColor(client, is(COLORS.disconnected)); // lit phase
      await nextColor(client, is({ r: 0, g: 0, b: 0 })); // dark phase — proof it flashes
      await nextColor(client, is(COLORS.disconnected)); // lit again
    } finally {
      client.close();
    }
  });
});

test("two devices on different inputs show different colours", async () => {
  await withStack(async (stack) => {
    await connectSource(stack); // program 1, preview 2
    const live = new TallyClient({ mac: "aa:bb:cc:dd:ee:03", heartbeatIntervalMs: 60_000 });
    const preview = new TallyClient({ mac: "aa:bb:cc:dd:ee:04", heartbeatIntervalMs: 60_000 });
    try {
      live.connect(LOCAL, stack.server.tcpPort);
      preview.connect(LOCAL, stack.server.tcpPort);
      await Promise.all([once(live, "connected"), once(preview, "connected")]);

      const liveRed = nextColor(live, is(COLORS.live));
      const previewGreen = nextColor(preview, is(COLORS.preview));
      stack.command({ type: "assignDevice", mac: "aa:bb:cc:dd:ee:03", inputId: 1 });
      stack.command({ type: "assignDevice", mac: "aa:bb:cc:dd:ee:04", inputId: 2 });
      await Promise.all([liveRed, previewGreen]);
    } finally {
      live.close();
      preview.close();
    }
  });
});

test("identify drives a server-streamed locate strobe (white/off SET_COLORs)", async () => {
  await withStack(async (stack) => {
    const mac = "aa:bb:cc:dd:ee:05";
    const client = new TallyClient({ mac, heartbeatIntervalMs: 60_000 });
    try {
      // Wait for the first colour (setup) — that proves the server has processed the
      // HELLO and registered the device, so identify can be routed to it.
      const ready = once(client, "setColor");
      client.connect(LOCAL, stack.server.tcpPort);
      await ready;

      // The strobe's dark phase ({0,0,0}) is unique to the locate flash — no resting state is
      // ever fully off — so receiving it proves the server is driving the flash over SET_COLOR.
      const dark = new Promise<void>((resolve) => {
        client.on("setColor", (color) => {
          if (color.r === 0 && color.g === 0 && color.b === 0) resolve();
        });
      });
      stack.command({ type: "identifyDevice", mac });
      await dark;
    } finally {
      client.close();
    }
  });
});

test("brightness changes are applied to the device's colour", async () => {
  await withStack(async (stack) => {
    await connectSource(stack);
    const mac = "aa:bb:cc:dd:ee:06";
    const client = new TallyClient({ mac, heartbeatIntervalMs: 60_000 });
    try {
      client.connect(LOCAL, stack.server.tcpPort);
      await once(client, "connected");
      stack.command({ type: "assignDevice", mac, inputId: 1 });
      await nextColor(client, is(COLORS.live));

      const dimmed = nextColor(client, () => true); // next colour, whatever it is
      stack.command({ type: "setBrightness", mac, brightness: 32 });
      const { color, brightness } = await dimmed;
      assert.deepEqual(color, COLORS.live);
      assert.equal(brightness, 32);
    } finally {
      client.close();
    }
  });
});

test("assignments survive a sidecar restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tallybot-e2e-persist-"));
  const stateFile = join(dir, "state.json");
  const mac = "aa:bb:cc:dd:ee:07";

  // Session 1: assign the device, then shut down.
  const first = await buildStack(stateFile);
  try {
    await connectSource(first);
    const client = new TallyClient({ mac, heartbeatIntervalMs: 60_000 });
    try {
      client.connect(LOCAL, first.server.tcpPort);
      await once(client, "connected");
      const gotLive = nextColor(client, is(COLORS.live));
      first.command({ type: "assignDevice", mac, inputId: 1 });
      await gotLive;
    } finally {
      client.close();
    }
  } finally {
    await first.stop();
  }

  // Session 2: a brand-new sidecar over the same state file remembers the assignment.
  const second = await buildStack(stateFile);
  try {
    await connectSource(second);
    const client = new TallyClient({ mac, heartbeatIntervalMs: 60_000 });
    try {
      // No assign command this time — it should already be wired to input 1 (live).
      const gotLive = nextColor(client, is(COLORS.live));
      client.connect(LOCAL, second.server.tcpPort);
      await gotLive;
      assert.equal(second.latestState()!.devices.find((d) => d.mac === mac)!.inputId, 1);
    } finally {
      client.close();
    }
  } finally {
    await second.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("main.ts's default composition carries USB, ESP-NOW relay, firmware, STATUS, logs and bridge routing to the UI", async () => {
  const bridge = "bb:bb:bb:bb:bb:01";
  const light = "11:22:33:44:55:66";
  const usbFrame = (mac: string, payload: Uint8Array): UsbInbound => ({ type: "usbFrame", mac, payloadHex: toHex(payload) });
  const text = (s: string): number[] => [...new TextEncoder().encode(s)];
  const device = (stack: Stack, mac: string) => stack.latestState()?.devices.find((d) => d.mac === mac);
  const sentTo = (stack: Stack, mac: string, prefix: number[]) =>
    stack.usbSends.find((m) => m.mac === mac && m.payloadHex.startsWith(toHex(Uint8Array.from(prefix))));

  await withStack(
    async (stack) => {
      // The shell saw a v3 light's HELLO on a USB port.
      stack.shell({ type: "usbDeviceConnected", mac: bridge, version: 3 });
      await eventually("the USB device in a snapshot", () => (device(stack, bridge)?.transport === "usb" ? true : undefined));

      stack.shell(usbFrame(bridge, Uint8Array.of(DeviceMessageType.FIRMWARE, ...text("1.2.0"))));
      const firmware = await eventually("the USB device's firmware version", () => {
        const f = device(stack, bridge)?.firmware;
        return f?.kind === "reported" ? f : undefined;
      });
      assert.deepEqual(firmware, { kind: "reported", version: "1.2.0" });

      // STATUS: provisioned for WiFi, idle, no RSSI, no stored SSID.
      stack.shell(usbFrame(bridge, Uint8Array.of(DeviceMessageType.STATUS, Transport.WIFI, WifiState.IDLE, 0, 0)));
      await eventually("the STATUS-reported provisioned mode", () => (device(stack, bridge)?.provisionedMode === "wifi" ? true : undefined));

      stack.shell(usbFrame(bridge, Uint8Array.of(DeviceMessageType.LOG, LogLevel.WARN, ...text("joining GreenRoom"))));
      const log = await eventually("the device's LOG as a deviceLog event", () =>
        stack.events.find((e) => e.type === "deviceLog" && e.mac === bridge),
      );
      assert.deepEqual(log, { type: "deviceLog", mac: bridge, level: "warn", text: "joining GreenRoom" });

      // Designating the bridge sends it SET_BRIDGE 1 down its cable.
      stack.command({ type: "setBridge", mac: bridge });
      await eventually("SET_BRIDGE 1 to the bridge", () => sentTo(stack, bridge, [ServerMessageType.SET_BRIDGE, 1]));

      // A light's HELLO relayed up through the bridge: it appears as an ESP-NOW device, and its
      // colour goes back down the bridge's cable inside a RELAY addressed to it.
      const hello = Uint8Array.of(DeviceMessageType.HELLO, 3, ...parseMac(light));
      stack.shell(usbFrame(bridge, Uint8Array.of(DeviceMessageType.RELAY, ...parseMac(light), ...hello)));
      await eventually("the relayed light in a snapshot", () => (device(stack, light)?.transport === "espnow" ? true : undefined));
      await eventually("a RELAY to the light via the bridge", () =>
        sentTo(stack, bridge, [ServerMessageType.RELAY, ...parseMac(light), ServerMessageType.SET_COLOR]),
      );
    },
    "default",
  );
});

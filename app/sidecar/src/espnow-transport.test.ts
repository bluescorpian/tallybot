import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { EspNowTransport } from "./espnow-transport.ts";
import { COLORS, DeviceMessageType, LogLevel, ServerMessageType } from "./protocol.ts";
import type { UsbTransport } from "./usb-transport.ts";
import { fromHex, toHex } from "./usb-bridge.ts";

/**
 * A minimal stand-in for the UsbTransport: lets a test drive the `relayed` / `deviceDisconnected`
 * events the EspNowTransport subscribes to, and captures the RELAY payloads it sends down. Only the
 * three members the transport touches are implemented (cast through `unknown` for the rest).
 */
class FakeUsb extends EventEmitter {
  readonly relays: Array<{ bridgeMac: string; payload: Uint8Array }> = [];
  /** Set false to simulate the designated bridge not being on USB (the write has nowhere to go). */
  bridgeOnUsb = true;
  sendBridgeRelay(bridgeMac: string, payload: Uint8Array): boolean {
    if (!this.bridgeOnUsb) return false;
    this.relays.push({ bridgeMac, payload });
    return true;
  }
  /** Drive an inbound RELAY frame as the UsbTransport would after decoding the envelope. */
  relay(bridgeMac: string, srcMac: string, inner: Uint8Array): void {
    this.emit("relayed", { bridgeMac, srcMac, inner });
  }
  /** Drive a USB device drop (used to simulate the bridge unplugging). */
  drop(mac: string): void {
    this.emit("deviceDisconnected", { mac });
  }
  asUsb(): UsbTransport {
    return this as unknown as UsbTransport;
  }
}

const BRIDGE = "bb:bb:bb:bb:bb:01";
const LIGHT = "11:22:33:44:55:66";
const LIGHT2 = "77:88:99:aa:bb:cc";

function helloInner(version: number): Uint8Array {
  // [type][version][MAC×6] — the MAC bytes are ignored (srcMac from the envelope is the identity).
  return Uint8Array.of(DeviceMessageType.HELLO, version, 0, 0, 0, 0, 0, 0);
}
const HEARTBEAT = Uint8Array.of(DeviceMessageType.HEARTBEAT);

type LogEntry = { mac: string; level: string; text: string };

/** A controllable clock so expiry is deterministic (no wall-clock waits). */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("a relayed HELLO surfaces as deviceConnected with the light's MAC and version", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  const connected: Array<{ mac: string; version: number }> = [];
  espnow.on("deviceConnected", (i) => connected.push(i));

  usb.relay(BRIDGE, LIGHT, helloInner(3));
  assert.deepEqual(connected, [{ mac: LIGHT, version: 3 }]);
});

test("an unsupported relayed version raises deviceUnsupported (still connects)", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  const unsupported: Array<{ mac: string; version: number; reason: string }> = [];
  espnow.on("deviceUnsupported", (i) => unsupported.push(i));

  usb.relay(BRIDGE, LIGHT, helloInner(0)); // below MIN_SUPPORTED
  assert.deepEqual(unsupported, [{ mac: LIGHT, version: 0, reason: "device-too-old" }]);
});

test("heartbeats keep a relayed light alive past the timeout; silence expires it", async () => {
  const clock = makeClock();
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb(), {
    heartbeatTimeoutMs: 1000,
    sweepIntervalMs: 10,
    now: clock.now,
  });
  const disconnected: Array<{ mac: string }> = [];
  espnow.on("deviceDisconnected", (i) => disconnected.push(i));
  const logs: LogEntry[] = [];
  espnow.on("log", (e) => logs.push(e));
  await espnow.start();
  try {
    usb.relay(BRIDGE, LIGHT, helloInner(3));

    // Heartbeat at t+800 refreshes lastSeen; a sweep at t+1500 (700 ms after the beat) keeps it.
    clock.advance(800);
    usb.relay(BRIDGE, LIGHT, HEARTBEAT);
    clock.advance(700);
    await sweepOnce(espnow);
    assert.deepEqual(disconnected, [], "still alive — beat was within the window");
    assert.equal(logs.length, 0, "a live light is not logged");

    // Now go silent past the timeout (last seen at the t=800 beat; 1800 ms silent by the sweep).
    clock.advance(1100);
    await sweepOnce(espnow);
    assert.deepEqual(disconnected, [{ mac: LIGHT }], "expired after the timeout");
    await sweepOnce(espnow);
    assert.deepEqual(disconnected, [{ mac: LIGHT }], "expired once, not on every sweep");

    // The drop is logged once, naming the light and its 1.8 s of silence.
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.mac, LIGHT);
    assert.equal(logs[0]!.level, "warn");
    assert.ok(logs[0]!.text.includes(LIGHT), `names the light: ${logs[0]!.text}`);
    assert.match(logs[0]!.text, /\b1\.8 ?s\b/, "says how long it had been silent");
  } finally {
    await espnow.stop();
  }
});

test("a wall-clock step neither drops a heartbeating light nor strands a silent one", async (t) => {
  // Default clock (no `now` option): liveness must run on elapsed time, not the system clock.
  const wallStep = (byMs: number) => {
    const real = Date.now.bind(Date);
    t.mock.method(Date, "now", () => real() + byMs);
  };

  // Forward: the clock jumps an hour ahead (NTP sync) right after a beat; the light stays.
  {
    const usb = new FakeUsb();
    const espnow = new EspNowTransport(usb.asUsb(), { heartbeatTimeoutMs: 1000, sweepIntervalMs: 10 });
    await espnow.start();
    try {
      usb.relay(BRIDGE, LIGHT, helloInner(3));
      wallStep(60 * 60_000);
      await sweepOnce(espnow);
      assert.deepEqual(espnow.connectedMacs(), [LIGHT], "a forward clock step must not drop a live light");
    } finally {
      await espnow.stop();
      t.mock.restoreAll();
    }
  }

  // Backward: the clock jumps an hour back, then the light goes silent past the timeout; it drops.
  {
    const usb = new FakeUsb();
    const espnow = new EspNowTransport(usb.asUsb(), { heartbeatTimeoutMs: 30, sweepIntervalMs: 10 });
    await espnow.start();
    try {
      usb.relay(BRIDGE, LIGHT, helloInner(3));
      wallStep(-60 * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(espnow.connectedMacs(), [], "a backward clock step must not keep a silent light");
    } finally {
      await espnow.stop();
      t.mock.restoreAll();
    }
  }
});

test("the bridge disconnecting from USB drops all relayed lights at once", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  espnow.setBridgeMac(BRIDGE);
  const disconnected: string[] = [];
  espnow.on("deviceDisconnected", ({ mac }) => disconnected.push(mac));

  usb.relay(BRIDGE, LIGHT, helloInner(3));
  usb.relay(BRIDGE, LIGHT2, helloInner(3));

  usb.drop(BRIDGE); // cable pulled
  assert.deepEqual(disconnected.sort(), [LIGHT, LIGHT2].sort(), "every relayed light dropped");

  // A non-bridge USB drop must NOT touch relayed lights.
  usb.relay(BRIDGE, LIGHT, helloInner(3));
  disconnected.length = 0;
  usb.drop("de:ad:de:ad:de:ad");
  assert.deepEqual(disconnected, []);
});

test("sendColor wraps SET_COLOR in a RELAY envelope to the bridge, and fails with no bridge", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());

  // No bridge designated yet → can't route.
  assert.equal(espnow.sendColor(LIGHT, COLORS.live, 64), false);
  assert.equal(usb.relays.length, 0);

  espnow.setBridgeMac(BRIDGE);
  assert.equal(espnow.sendColor(LIGHT, COLORS.live, 64), true);
  assert.equal(usb.relays.length, 1);
  assert.equal(usb.relays[0]!.bridgeMac, BRIDGE, "addressed to the bridge's cable");
  assert.deepEqual(
    [...usb.relays[0]!.payload],
    [
      ServerMessageType.RELAY,
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, // the light's MAC
      ServerMessageType.SET_COLOR, 255, 0, 0, 64, // the inner SET_COLOR payload
    ],
  );

  // Clearing the bridge stops routing again.
  espnow.setBridgeMac(null);
  assert.equal(espnow.sendColor(LIGHT, COLORS.live, 64), false);
});

// A light re-HELLOs every ~1 s until the first frame arrives from the bridge (spec, discovery
// step 3) — repeats must refresh, not duplicate. (Each one re-emits deviceConnected on purpose,
// matching the TCP server's reconnect re-announce.)
test("repeated HELLOs from the same light refresh it without duplicating", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  espnow.setBridgeMac(BRIDGE);
  const connected: Array<{ mac: string; version: number }> = [];
  espnow.on("deviceConnected", (i) => connected.push(i));
  const disconnected: string[] = [];
  espnow.on("deviceDisconnected", ({ mac }) => disconnected.push(mac));

  usb.relay(BRIDGE, LIGHT, helloInner(3));
  usb.relay(BRIDGE, LIGHT, helloInner(3));
  usb.relay(BRIDGE, LIGHT, helloInner(3));
  assert.equal(connected.length, 3, "each HELLO re-announces (reconnect semantics)");
  usb.drop(BRIDGE);
  assert.deepEqual(disconnected, [LIGHT], "one light to drop, however many HELLOs");
});

test("a HEARTBEAT from an unknown light is ignored (HELLO must come first)", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  const connected: Array<{ mac: string; version: number }> = [];
  espnow.on("deviceConnected", (i) => connected.push(i));

  usb.relay(BRIDGE, LIGHT, HEARTBEAT); // never said HELLO — no version to record
  assert.deepEqual(connected, []);
});

test("a relayed FIRMWARE is reported for a light whose HELLO was seen, and ignored before it", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  const reported: Array<{ mac: string; version: string }> = [];
  espnow.on("firmware", (i) => reported.push(i));
  const firmware = Uint8Array.of(0x07, ...new TextEncoder().encode("1.1.0"));

  usb.relay(BRIDGE, LIGHT, firmware); // unknown light: ignored
  assert.deepEqual(reported, []);
  usb.relay(BRIDGE, LIGHT, helloInner(3));
  usb.relay(BRIDGE, LIGHT, firmware);
  assert.deepEqual(reported, [{ mac: LIGHT, version: "1.1.0" }]);
});

test("orphan HEARTBEATs warn once per MAC, and a HELLO re-arms the warning", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  espnow.setBridgeMac(BRIDGE);
  const logs: LogEntry[] = [];
  espnow.on("log", (e) => logs.push(e));
  const warnedMacs = () => logs.filter((e) => e.level === "warn").map((e) => e.mac);
  const connected: string[] = [];
  espnow.on("deviceConnected", ({ mac }) => connected.push(mac));

  usb.relay(BRIDGE, LIGHT, HEARTBEAT);
  usb.relay(BRIDGE, LIGHT, HEARTBEAT);
  usb.relay(BRIDGE, LIGHT, HEARTBEAT);
  usb.relay(BRIDGE, LIGHT2, HEARTBEAT);
  assert.deepEqual(warnedMacs(), [LIGHT, LIGHT2], "one warning per MAC, not per HEARTBEAT");
  assert.deepEqual(connected, [], "still ignored");

  // LIGHT says HELLO, then is forgotten (bridge unplugged) — its next orphan HEARTBEAT is news again.
  usb.relay(BRIDGE, LIGHT, helloInner(3));
  usb.drop(BRIDGE);
  usb.relay(BRIDGE, LIGHT, HEARTBEAT);
  usb.relay(BRIDGE, LIGHT2, HEARTBEAT); // never said HELLO — stays quiet
  assert.deepEqual(warnedMacs(), [LIGHT, LIGHT2, LIGHT]);
});

test("sendColor failures log one warning per outage and one info line on recovery", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  const logs: LogEntry[] = [];
  espnow.on("log", (e) => logs.push(e));
  const levels = () => logs.map((e) => e.level);

  // Outage 1: no bridge designated. Every keyframe fails; only the first is logged.
  for (let i = 0; i < 5; i++) assert.equal(espnow.sendColor(LIGHT, COLORS.live, 64), false);
  assert.deepEqual(levels(), ["warn"]);

  espnow.setBridgeMac(BRIDGE);
  assert.equal(espnow.sendColor(LIGHT, COLORS.live, 64), true);
  assert.equal(espnow.sendColor(LIGHT, COLORS.live, 64), true);
  assert.deepEqual(levels(), ["warn", "info"], "one recovery line, not one per good send");
  assert.match(logs[1]!.text, /recovered/);

  // Outage 2: a bridge is designated but isn't on USB.
  usb.bridgeOnUsb = false;
  for (let i = 0; i < 5; i++) assert.equal(espnow.sendColor(LIGHT2, COLORS.live, 64), false);
  assert.deepEqual(levels(), ["warn", "info", "warn"]);

  usb.bridgeOnUsb = true;
  assert.equal(espnow.sendColor(LIGHT2, COLORS.live, 64), true);
  assert.deepEqual(levels(), ["warn", "info", "warn", "info"]);
  assert.match(logs[3]!.text, /recovered/);
});

function logInner(level: number, text: string): Uint8Array {
  // [type][level][utf8…]
  return Uint8Array.of(DeviceMessageType.LOG, level, ...new TextEncoder().encode(text));
}

test("a light's relayed LOG line surfaces as a log event keyed by the light's MAC", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  espnow.setBridgeMac(BRIDGE);
  const logs: LogEntry[] = [];
  espnow.on("log", (e) => logs.push(e));

  usb.relay(BRIDGE, LIGHT, helloInner(3));
  usb.relay(BRIDGE, LIGHT, logInner(LogLevel.WARN, "relink gap 5210ms timeout#2"));
  usb.relay(BRIDGE, LIGHT2, logInner(LogLevel.INFO, "hi"));
  usb.relay(BRIDGE, LIGHT2, logInner(LogLevel.ERROR, "bad"));

  assert.deepEqual(logs, [
    { mac: LIGHT, level: "warn", text: "relink gap 5210ms timeout#2" },
    { mac: LIGHT2, level: "info", text: "hi" },
    { mac: LIGHT2, level: "error", text: "bad" },
  ]);
});

test("a LOG from a known light keeps it alive past the timeout, like a HEARTBEAT", async () => {
  const clock = makeClock();
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb(), {
    heartbeatTimeoutMs: 1000,
    sweepIntervalMs: 10,
    now: clock.now,
  });
  const disconnected: Array<{ mac: string }> = [];
  espnow.on("deviceDisconnected", (i) => disconnected.push(i));
  espnow.on("log", () => {});
  await espnow.start();
  try {
    usb.relay(BRIDGE, LIGHT, helloInner(3));

    // A LOG at t=800 is the light's only frame; a sweep at t=1500 (1.5 s after HELLO) keeps it.
    clock.advance(800);
    usb.relay(BRIDGE, LIGHT, logInner(LogLevel.WARN, "relink gap 5000ms timeout#1"));
    clock.advance(700);
    await sweepOnce(espnow);
    assert.deepEqual(disconnected, [], "the LOG refreshed liveness");
  } finally {
    await espnow.stop();
  }
});

test("a corrupt relayed inner payload is surfaced as an error, not a crash", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  const errors: Error[] = [];
  espnow.on("error", (e) => errors.push(e));
  const connected: string[] = [];
  espnow.on("deviceConnected", ({ mac }) => connected.push(mac));

  usb.relay(BRIDGE, LIGHT, Uint8Array.of(0x7f)); // unknown inner type
  assert.equal(errors.length, 1);
  assert.deepEqual(connected, [], "nothing connected from a bad frame");
});

// Confirm the RELAY envelope decodes back into something the bridge could re-emit. Belt-and-braces
// against the byte layout drifting from `relayPayload`.
test("the RELAY payload sendColor builds round-trips through fromHex/toHex unchanged", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  espnow.setBridgeMac(BRIDGE);
  espnow.sendColor(LIGHT, COLORS.idle, 128);
  const bytes = usb.relays[0]!.payload;
  assert.deepEqual([...fromHex(toHex(bytes))], [...bytes]);
});

/**
 * Wait for the transport's real expiry interval (`sweepIntervalMs`) to fire at least once. The
 * sweep timer runs on the wall clock but reads the *injected* `now`, so advancing the fake clock and
 * then yielding past one interval lets a deterministic sweep observe the new time.
 */
function sweepOnce(_espnow: EspNowTransport): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

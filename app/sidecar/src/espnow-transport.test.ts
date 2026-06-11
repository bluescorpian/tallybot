import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { EspNowTransport } from "./espnow-transport.ts";
import { COLORS, DeviceMessageType, ServerMessageType } from "./protocol.ts";
import type { UsbTransport } from "./usb-transport.ts";
import { fromHex, toHex } from "./usb-bridge.ts";

/**
 * A minimal stand-in for the UsbTransport: lets a test drive the `relayed` / `deviceDisconnected`
 * events the EspNowTransport subscribes to, and captures the RELAY payloads it sends down. Only the
 * three members the transport touches are implemented (cast through `unknown` for the rest).
 */
class FakeUsb extends EventEmitter {
  readonly relays: Array<{ bridgeMac: string; payload: Uint8Array }> = [];
  sendBridgeRelay(bridgeMac: string, payload: Uint8Array): boolean {
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
  assert.deepEqual(espnow.connectedMacs(), [LIGHT]);
});

test("an unsupported relayed version raises deviceUnsupported (still connects)", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  const unsupported: Array<{ mac: string; version: number }> = [];
  espnow.on("deviceUnsupported", (i) => unsupported.push(i));

  usb.relay(BRIDGE, LIGHT, helloInner(0)); // below MIN_SUPPORTED
  assert.deepEqual(unsupported, [{ mac: LIGHT, version: 0 }]);
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
  await espnow.start();
  try {
    usb.relay(BRIDGE, LIGHT, helloInner(3));

    // Heartbeat at t+800 refreshes lastSeen; a sweep at t+1500 (700 ms after the beat) keeps it.
    clock.advance(800);
    usb.relay(BRIDGE, LIGHT, HEARTBEAT);
    clock.advance(700);
    await sweepOnce(espnow);
    assert.deepEqual(disconnected, [], "still alive — beat was within the window");
    assert.deepEqual(espnow.connectedMacs(), [LIGHT]);

    // Now go silent past the timeout (last seen at t=1500; advance beyond +1000).
    clock.advance(1100);
    await sweepOnce(espnow);
    assert.deepEqual(disconnected, [{ mac: LIGHT }], "expired after the timeout");
    assert.deepEqual(espnow.connectedMacs(), []);
  } finally {
    await espnow.stop();
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
  assert.deepEqual(espnow.connectedMacs().sort(), [LIGHT, LIGHT2].sort());

  usb.drop(BRIDGE); // cable pulled
  assert.deepEqual(disconnected.sort(), [LIGHT, LIGHT2].sort(), "every relayed light dropped");
  assert.deepEqual(espnow.connectedMacs(), []);

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
  const connected: Array<{ mac: string; version: number }> = [];
  espnow.on("deviceConnected", (i) => connected.push(i));

  usb.relay(BRIDGE, LIGHT, helloInner(3));
  usb.relay(BRIDGE, LIGHT, helloInner(3));
  usb.relay(BRIDGE, LIGHT, helloInner(3));
  assert.deepEqual(espnow.connectedMacs(), [LIGHT], "one light, however many HELLOs");
  assert.equal(connected.length, 3, "each HELLO re-announces (reconnect semantics)");
});

test("a HEARTBEAT from an unknown light is ignored (HELLO must come first)", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  const connected: Array<{ mac: string; version: number }> = [];
  espnow.on("deviceConnected", (i) => connected.push(i));

  usb.relay(BRIDGE, LIGHT, HEARTBEAT); // never said HELLO — no version to record
  assert.deepEqual(connected, []);
  assert.deepEqual(espnow.connectedMacs(), []);
});

test("a corrupt relayed inner payload is surfaced as an error, not a crash", () => {
  const usb = new FakeUsb();
  const espnow = new EspNowTransport(usb.asUsb());
  const errors: Error[] = [];
  espnow.on("error", (e) => errors.push(e));

  usb.relay(BRIDGE, LIGHT, Uint8Array.of(0x7f)); // unknown inner type
  assert.equal(errors.length, 1);
  assert.deepEqual(espnow.connectedMacs(), [], "nothing connected from a bad frame");
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

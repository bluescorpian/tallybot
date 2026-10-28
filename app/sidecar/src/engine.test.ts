import { test } from "node:test";
import assert from "node:assert/strict";

import { type DeviceRecord, type SourceSnapshot, INACTIVE_GATE, computeEngine, tallyFor } from "./engine.ts";
import { COLORS, DEFAULT_BRIGHTNESS, SETUP_COLOR } from "./protocol.ts";
import type { ProgramGate } from "./ipc.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A connected ATEM with 3 inputs, program 1 / preview 2. */
function connectedSource(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    ip: "10.0.0.5",
    connection: "connected",
    programInput: 1,
    previewInput: 2,
    inputs: [
      { id: 1, label: "Camera 1" },
      { id: 2, label: "Camera 2" },
      { id: 3, label: "Camera 3" },
    ],
    ...overrides,
  };
}

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    mac: "aa:bb:cc:dd:ee:ff",
    macTail: "dd:ee:ff",
    online: true,
    protocolVersion: 1,
    inputId: null,
    brightness: DEFAULT_BRIGHTNESS,
    transport: "wifi",
    wifiState: null,
    rssi: null,
    ...overrides,
  };
}

const ACTIVE_GATE: ProgramGate = { active: true, source: "OBS" };

// ── tallyFor ─────────────────────────────────────────────────────────────────

test("tallyFor: program input is live, preview is preview, others idle", () => {
  const source = connectedSource();
  assert.equal(tallyFor(source, INACTIVE_GATE, 1), "live");
  assert.equal(tallyFor(source, INACTIVE_GATE, 2), "preview");
  assert.equal(tallyFor(source, INACTIVE_GATE, 3), "idle");
});

test("tallyFor: an active program gate forces every input to idle", () => {
  const source = connectedSource();
  assert.equal(tallyFor(source, ACTIVE_GATE, 1), "idle");
  assert.equal(tallyFor(source, ACTIVE_GATE, 2), "idle");
});

test("tallyFor: an untrustworthy source reports unknown, never a misleading idle", () => {
  // Disconnected, mid-reconnect, and connected-but-no-program-yet are all states
  // where we can't assert what's live — so the input is the fault state, not idle.
  assert.equal(tallyFor(connectedSource({ connection: "disconnected" }), INACTIVE_GATE, 1), "unknown");
  assert.equal(tallyFor(connectedSource({ connection: "connecting" }), INACTIVE_GATE, 1), "unknown");
  assert.equal(tallyFor(connectedSource({ programInput: null }), INACTIVE_GATE, 1), "unknown");
});

test("tallyFor: an active program gate still wins over an untrustworthy source", () => {
  // The gate is a deliberate, known 'no program' — idle, not a fault.
  assert.equal(tallyFor(connectedSource({ connection: "disconnected" }), ACTIVE_GATE, 1), "idle");
});

// ── computeEngine: per-device colour ────────────────────────────────────────────

test("an assigned device shows its input's tally colour", () => {
  const source = connectedSource();
  const devices = [
    device({ mac: "00:00:00:00:00:01", inputId: 1 }), // program → live
    device({ mac: "00:00:00:00:00:02", inputId: 2 }), // preview
    device({ mac: "00:00:00:00:00:03", inputId: 3 }), // idle
  ];
  const { colors } = computeEngine(source, INACTIVE_GATE, devices);
  assert.deepEqual(colors[0]!.color, COLORS.live);
  assert.deepEqual(colors[1]!.color, COLORS.preview);
  assert.deepEqual(colors[2]!.color, COLORS.idle);
});

test("an unassigned online device shows the setup colour", () => {
  const { colors, state } = computeEngine(connectedSource(), INACTIVE_GATE, [device({ inputId: null })]);
  assert.equal(colors.length, 1);
  assert.deepEqual(colors[0]!.color, SETUP_COLOR);
  assert.equal(colors[0]!.anim, "breathe", "the unassigned breathe, not a fault flash");
  assert.equal(state.devices[0]!.state, "unassigned");
});

test("an assigned device on an untrustworthy source flashes blue, never idle green", () => {
  const source = connectedSource({ connection: "disconnected" });
  const { colors, state } = computeEngine(source, INACTIVE_GATE, [device({ inputId: 1 })]);
  assert.deepEqual(colors[0]!.color, COLORS.disconnected, "the fault hue is blue");
  assert.equal(colors[0]!.anim, "flash", "and it flashes, so it can't be mistaken for idle");
  assert.equal(state.inputs[0]!.tally, "unknown");
});

test("an *unassigned* device stays setup-coloured even when the source is down", () => {
  // No input bound → no tally to be wrong about, so it breathes setup, never flashes fault.
  const { colors } = computeEngine(
    connectedSource({ connection: "disconnected" }),
    INACTIVE_GATE,
    [device({ inputId: null })],
  );
  assert.deepEqual(colors[0]!.color, SETUP_COLOR);
  assert.equal(colors[0]!.anim, "breathe");
});

test("an offline device yields no colour command and reads as offline", () => {
  const { colors, state } = computeEngine(connectedSource(), INACTIVE_GATE, [
    device({ online: false, inputId: 1 }),
  ]);
  assert.equal(colors.length, 0, "offline devices get no SET_COLOR");
  assert.equal(state.devices[0]!.state, "offline");
});

test("per-device brightness is carried into the colour command", () => {
  const { colors } = computeEngine(connectedSource(), INACTIVE_GATE, [device({ inputId: 1, brightness: 42 })]);
  assert.equal(colors[0]!.brightness, 42);
});

test("an active program gate drops assigned devices to idle", () => {
  const { colors } = computeEngine(connectedSource(), ACTIVE_GATE, [device({ inputId: 1 })]);
  assert.deepEqual(colors[0]!.color, COLORS.idle, "gate blocks program, so even the live input is idle");
});

// ── computeEngine: AppState snapshot ─────────────────────────────────────────────

test("the snapshot mirrors source connection, ip, inputs, and gate", () => {
  const source = connectedSource();
  const { state } = computeEngine(source, INACTIVE_GATE, []);
  assert.deepEqual(state.source, { kind: "atem", ip: "10.0.0.5", connection: "connected" });
  assert.deepEqual(
    state.inputs,
    [
      { id: 1, label: "Camera 1", tally: "live" },
      { id: 2, label: "Camera 2", tally: "preview" },
      { id: 3, label: "Camera 3", tally: "idle" },
    ],
  );
  assert.deepEqual(state.programGate, INACTIVE_GATE);
});

test("the device snapshot carries identity, assignment, and brightness through", () => {
  const { state } = computeEngine(connectedSource(), INACTIVE_GATE, [
    device({
      mac: "aa:bb:cc:dd:ee:ff",
      macTail: "dd:ee:ff",
      inputId: 2,
      brightness: 200,
      firmware: { kind: "reported", version: "1.2.0" },
    }),
  ]);
  assert.deepEqual(state.devices[0], {
    mac: "aa:bb:cc:dd:ee:ff",
    macTail: "dd:ee:ff",
    state: "assigned",
    inputId: 2,
    brightness: 200,
    protocolVersion: 1,
    firmware: { kind: "reported", version: "1.2.0" },
    transport: "wifi",
    wifiState: null,
    rssi: null,
    provisionedMode: null,
    ssid: null,
    bridge: false,
    espnowChannel: null,
  });
});

test("the device snapshot carries the USB provisioned mode and SSID through", () => {
  const { state } = computeEngine(connectedSource(), INACTIVE_GATE, [
    device({ transport: "usb", provisionedMode: "wifi", ssid: "GreenRoom-5G" }),
  ]);
  assert.equal(state.devices[0]!.transport, "usb");
  assert.equal(state.devices[0]!.provisionedMode, "wifi");
  assert.equal(state.devices[0]!.ssid, "GreenRoom-5G");
});

// ── Mid-mix (AUTO / T-bar) ──────────────────────────────────────────────────────

// During a mix the ATEM has already moved preview on to the source queued for after it,
// so the incoming source is carried on the transition. Here: 1 → 2 is mixing, 3 is queued.
const MIXING = connectedSource({ programInput: 1, previewInput: 3, transition: { incomingInput: 2, progress: 0.25 } });

test("tallyFor: mid-mix both the outgoing and incoming sources are live, the queued one preview", () => {
  assert.equal(tallyFor(MIXING, INACTIVE_GATE, 1), "live", "outgoing");
  assert.equal(tallyFor(MIXING, INACTIVE_GATE, 2), "live", "incoming");
  assert.equal(tallyFor(MIXING, INACTIVE_GATE, 3), "preview", "next queued");
});

test("mid-mix, the incoming light fades preview→live and the outgoing one live→idle", () => {
  const devices = [
    device({ mac: "00:00:00:00:00:01", inputId: 1 }), // outgoing, not on preview → settles idle
    device({ mac: "00:00:00:00:00:02", inputId: 2 }), // incoming
    device({ mac: "00:00:00:00:00:03", inputId: 3 }), // queued on preview, not in the mix
    device({ mac: "00:00:00:00:00:04", inputId: 4 }), // not in the mix
  ];
  const { colors } = computeEngine(MIXING, INACTIVE_GATE, devices);
  // 25% of the way: straight RGB blend, rounded.
  assert.deepEqual(colors[0]!.color, { r: 199, g: 8, b: 8 }, "red 25% toward idle (30,30,30)");
  assert.deepEqual(colors[1]!.color, { r: 64, g: 191, b: 0 }, "green 25% toward red");
  assert.deepEqual(colors[2]!.color, COLORS.preview, "preview untouched by the mix");
  assert.deepEqual(colors[3]!.color, COLORS.idle, "idle untouched by the mix");
  assert.ok(colors.every((c) => c.anim === "none"));
});

test("mid-mix, an outgoing light that is now on preview fades live→preview", () => {
  // The real AUTO case: preview moves to the outgoing source as the mix starts.
  const source = connectedSource({ programInput: 1, previewInput: 1, transition: { incomingInput: 2, progress: 0.25 } });
  const { colors } = computeEngine(source, INACTIVE_GATE, [device({ inputId: 1 })]);
  assert.deepEqual(colors[0]!.color, { r: 191, g: 64, b: 0 }, "red 25% toward green");
});

test("the mix's end points are the plain tally colours", () => {
  const devices = [device({ mac: "00:00:00:00:00:01", inputId: 1 }), device({ mac: "00:00:00:00:00:02", inputId: 2 })];
  const start = computeEngine({ ...MIXING, transition: { incomingInput: 2, progress: 0 } }, INACTIVE_GATE, devices);
  assert.deepEqual(start.colors[0]!.color, COLORS.live);
  assert.deepEqual(start.colors[1]!.color, COLORS.preview);
  const end = computeEngine({ ...MIXING, transition: { incomingInput: 2, progress: 1 } }, INACTIVE_GATE, devices);
  assert.deepEqual(end.colors[0]!.color, COLORS.idle);
  assert.deepEqual(end.colors[1]!.color, COLORS.live);
});

test("mixing a source onto itself shows plain live, no blend", () => {
  const source = connectedSource({ programInput: 1, previewInput: 2, transition: { incomingInput: 1, progress: 0.5 } });
  const { colors } = computeEngine(source, INACTIVE_GATE, [device({ inputId: 1 })]);
  assert.deepEqual(colors[0]!.color, COLORS.live);
});

test("mid-mix, an active gate and an untrusted source still win over the blend", () => {
  const devices = [device({ mac: "00:00:00:00:00:01", inputId: 1 }), device({ mac: "00:00:00:00:00:02", inputId: 2 })];
  const gated = computeEngine(MIXING, ACTIVE_GATE, devices);
  assert.deepEqual(gated.colors.map((c) => c.color), [COLORS.idle, COLORS.idle]);

  const fault = computeEngine({ ...MIXING, connection: "connecting" }, INACTIVE_GATE, devices);
  assert.deepEqual(fault.colors.map((c) => [c.color, c.anim]), [
    [COLORS.disconnected, "flash"],
    [COLORS.disconnected, "flash"],
  ]);
});

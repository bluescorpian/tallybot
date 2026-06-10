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

test("firmwareOutdated is set only below MIN_SUPPORTED, never for an unseen version", () => {
  const source = connectedSource();
  const { state } = computeEngine(source, INACTIVE_GATE, [
    device({ mac: "00:00:00:00:00:01", protocolVersion: 0 }), // below MIN_SUPPORTED (1)
    device({ mac: "00:00:00:00:00:02", protocolVersion: 1 }), // current
    device({ mac: "00:00:00:00:00:03", protocolVersion: null }), // never connected
  ]);
  assert.equal(state.devices[0]!.firmwareOutdated, true);
  assert.equal(state.devices[1]!.firmwareOutdated, false);
  assert.equal(state.devices[2]!.firmwareOutdated, false);
});

test("the device snapshot carries identity, assignment, and brightness through", () => {
  const { state } = computeEngine(connectedSource(), INACTIVE_GATE, [
    device({ mac: "aa:bb:cc:dd:ee:ff", macTail: "dd:ee:ff", inputId: 2, brightness: 200 }),
  ]);
  assert.deepEqual(state.devices[0], {
    mac: "aa:bb:cc:dd:ee:ff",
    macTail: "dd:ee:ff",
    state: "assigned",
    inputId: 2,
    brightness: 200,
    protocolVersion: 1,
    firmwareOutdated: false,
    transport: "wifi",
    wifiState: null,
    rssi: null,
    provisionedMode: null,
    ssid: null,
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

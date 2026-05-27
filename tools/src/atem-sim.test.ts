import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { type FakeAtemState, FakeAtem } from "./atem-sim.ts";

/** Capture the latest stateChanged emission for synchronous assertions. */
function captureChanges(atem: FakeAtem): { last: { state: FakeAtemState; paths: string[] } | null } {
  const box: { last: { state: FakeAtemState; paths: string[] } | null } = { last: null };
  atem.on("stateChanged", (state, paths) => {
    box.last = { state, paths };
  });
  return box;
}

// ── Construction ───────────────────────────────────────────────────────────────

test("a new FakeAtem seeds inputs and an initial program/preview", () => {
  const atem = new FakeAtem();
  assert.equal(Object.keys(atem.state.inputs).length, 4);
  assert.deepEqual(atem.state.inputs[1], { inputId: 1, longName: "Camera 1", shortName: "Cam1" });
  assert.equal(atem.state.video.mixEffects[0]!.programInput, 1);
  assert.equal(atem.state.video.mixEffects[0]!.previewInput, 2);
});

test("construction options override input count, names, and initial state", () => {
  const atem = new FakeAtem({
    inputCount: 2,
    inputNames: { 1: "Wide Shot" },
    programInput: 2,
    previewInput: 1,
  });
  assert.equal(Object.keys(atem.state.inputs).length, 2);
  assert.equal(atem.state.inputs[1]!.longName, "Wide Shot");
  assert.equal(atem.state.inputs[1]!.shortName, "Wide"); // first 4 chars of the override
  assert.equal(atem.state.video.mixEffects[0]!.programInput, 2);
  assert.equal(atem.state.video.mixEffects[0]!.previewInput, 1);
});

// ── Connection lifecycle ─────────────────────────────────────────────────────────

test("connect flips connected and emits connected", async () => {
  const atem = new FakeAtem();
  assert.equal(atem.connected, false);
  const connected = once(atem, "connected");
  await atem.connect("1.2.3.4");
  await connected;
  assert.equal(atem.connected, true);
});

test("disconnect flips connected and emits disconnected", async () => {
  const atem = new FakeAtem();
  const connected = once(atem, "connected");
  await atem.connect("1.2.3.4");
  await connected;
  const disconnected = once(atem, "disconnected");
  await atem.disconnect();
  await disconnected;
  assert.equal(atem.connected, false);
});

// ── Driving program / preview ────────────────────────────────────────────────────

test("changeProgramInput updates state and emits the program path", async () => {
  const atem = new FakeAtem();
  const changes = captureChanges(atem);
  await atem.changeProgramInput(3);
  assert.equal(atem.state.video.mixEffects[0]!.programInput, 3);
  assert.deepEqual(changes.last?.paths, ["video.mixEffects.0.programInput"]);
});

test("changePreviewInput updates state and emits the preview path", async () => {
  const atem = new FakeAtem();
  const changes = captureChanges(atem);
  await atem.changePreviewInput(4);
  assert.equal(atem.state.video.mixEffects[0]!.previewInput, 4);
  assert.deepEqual(changes.last?.paths, ["video.mixEffects.0.previewInput"]);
});

test("cut swaps program and preview and emits both paths", async () => {
  const atem = new FakeAtem({ programInput: 1, previewInput: 2 });
  const changes = captureChanges(atem);
  await atem.cut();
  assert.equal(atem.state.video.mixEffects[0]!.programInput, 2);
  assert.equal(atem.state.video.mixEffects[0]!.previewInput, 1);
  assert.deepEqual(changes.last?.paths, [
    "video.mixEffects.0.programInput",
    "video.mixEffects.0.previewInput",
  ]);
});

test("changing to an unknown input or mix effect throws", async () => {
  const atem = new FakeAtem({ inputCount: 2 });
  await assert.rejects(atem.changeProgramInput(9), RangeError);
  await assert.rejects(atem.changeProgramInput(1, 1), RangeError); // only ME 0 exists
});

// ── Input names ────────────────────────────────────────────────────────────────

test("setInputName renames an input and emits its path", () => {
  const atem = new FakeAtem();
  const changes = captureChanges(atem);
  atem.setInputName(2, "Close Up", "CU");
  assert.equal(atem.state.inputs[2]!.longName, "Close Up");
  assert.equal(atem.state.inputs[2]!.shortName, "CU");
  assert.deepEqual(changes.last?.paths, ["inputs.2.longName", "inputs.2.shortName"]);
});

test("setInputName rejects an unknown input", () => {
  const atem = new FakeAtem({ inputCount: 1 });
  assert.throws(() => atem.setInputName(5, "Nope"), RangeError);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { EventEmitter } from "node:events";

import { type AtemLike, type AtemStateSlice, AtemSource } from "./atem.ts";
import type { SourceSnapshot } from "./engine.ts";

/**
 * A minimal AtemLike for these unit tests — just enough to drive the lifecycle and
 * mutate state. (The Phase 1 `FakeAtem` exercises AtemSource end-to-end in tools/.)
 */
class MiniAtem extends EventEmitter implements AtemLike {
  state: AtemStateSlice;
  constructor(state: AtemStateSlice) {
    super();
    this.state = state;
  }
  connect(): Promise<void> {
    queueMicrotask(() => this.emit("connected"));
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    queueMicrotask(() => this.emit("disconnected"));
    return Promise.resolve();
  }
  setProgram(input: number): void {
    this.state.video!.mixEffects![0]!.programInput = input;
    this.emit("stateChanged", this.state, ["video.mixEffects.0.programInput"]);
  }
}

function seedState(): AtemStateSlice {
  return {
    video: { mixEffects: [{ programInput: 1, previewInput: 2 }] },
    inputs: {
      0: { longName: "Black" }, // excluded (below the camera range)
      1: { longName: "Camera 1", shortName: "Cam1" },
      2: { longName: "", shortName: "Cam2" }, // empty longName → falls back to shortName
      3: { shortName: "" }, // both empty → "Input 3"
      1000: { longName: "Color Bars" }, // excluded (internal source ≥ 1000)
    },
  };
}

/** Collect every `change` snapshot a source emits. */
function recordChanges(source: AtemSource): SourceSnapshot[] {
  const changes: SourceSnapshot[] = [];
  source.on("change", (s) => changes.push(s));
  return changes;
}

test("connecting moves through connecting → connected and reads the scene", async () => {
  const atem = new MiniAtem(seedState());
  const source = new AtemSource(atem);
  const changes = recordChanges(source);

  source.connect("10.0.0.5");
  await once(atem, "connected");

  assert.equal(changes[0]!.connection, "connecting", "connect() reports connecting straight away");
  const snap = source.snapshot();
  assert.equal(snap.connection, "connected");
  assert.equal(snap.ip, "10.0.0.5");
  assert.equal(snap.programInput, 1);
  assert.equal(snap.previewInput, 2);
});

test("inputs are filtered to the camera range, labelled, and sorted", async () => {
  const atem = new MiniAtem(seedState());
  const source = new AtemSource(atem);
  source.connect("10.0.0.5");
  await once(atem, "connected");

  assert.deepEqual(source.snapshot().inputs, [
    { id: 1, label: "Camera 1" },
    { id: 2, label: "Cam2" }, // shortName fallback
    { id: 3, label: "Input 3" }, // generated fallback
  ]);
});

test("a stateChanged updates program/preview and emits change", async () => {
  const atem = new MiniAtem(seedState());
  const source = new AtemSource(atem);
  source.connect("10.0.0.5");
  await once(atem, "connected");

  const changed = once(source, "change");
  atem.setProgram(3);
  await changed;
  assert.equal(source.snapshot().programInput, 3);
});

test("an unexpected drop reads as connecting (the library will retry)", async () => {
  const atem = new MiniAtem(seedState());
  const source = new AtemSource(atem);
  source.connect("10.0.0.5");
  await once(atem, "connected");

  atem.emit("disconnected"); // a network drop, not an explicit disconnect()
  assert.equal(source.snapshot().connection, "connecting");
});

test("an explicit disconnect reads as disconnected but keeps the inputs", async () => {
  const atem = new MiniAtem(seedState());
  const source = new AtemSource(atem);
  source.connect("10.0.0.5");
  await once(atem, "connected");

  await source.disconnect();
  const snap = source.snapshot();
  assert.equal(snap.connection, "disconnected");
  assert.equal(snap.inputs.length, 3, "the rig layout is retained while offline");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { EventEmitter } from "node:events";

import { type AtemLike, type AtemMixEffect, type AtemStateSlice, AtemSource } from "./atem.ts";
import type { SourceSnapshot } from "./engine.ts";

/**
 * A minimal AtemLike for these unit tests — just enough to drive the lifecycle and
 * mutate state. (The `FakeAtem` exercises AtemSource end-to-end in tools/.)
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
  /** Apply a mix-effect update in one packet, as the ATEM sends it. */
  update(me: AtemMixEffect): void {
    Object.assign(this.state.video!.mixEffects![0]!, me);
    this.emit("stateChanged", this.state, ["video.mixEffects.0"]);
  }
}

const mixing = (handlePosition: number): AtemMixEffect["transitionPosition"] => ({ inTransition: true, handlePosition });
const NOT_MIXING: AtemMixEffect["transitionPosition"] = { inTransition: false, handlePosition: 0 };

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

test("a mix holds the pre-mix preview as the incoming source until it ends", async () => {
  const atem = new MiniAtem(seedState()); // program 1, preview 2
  const source = new AtemSource(atem);
  source.connect("10.0.0.5");
  await once(atem, "connected");
  assert.equal(source.snapshot().transition ?? null, null, "no mix yet");

  // The packet that starts the mix also moves preview on to the source queued after it.
  atem.update({ previewInput: 1, transitionPosition: mixing(0) });
  assert.deepEqual(source.snapshot().transition, { incomingInput: 2, progress: 0 });
  assert.equal(source.snapshot().previewInput, 1);

  atem.update({ transitionPosition: mixing(5000) });
  assert.deepEqual(source.snapshot().transition, { incomingInput: 2, progress: 0.5 });

  // Preview changing again mid-mix doesn't change what's being mixed in.
  atem.update({ previewInput: 3, transitionPosition: mixing(7500) });
  assert.deepEqual(source.snapshot().transition, { incomingInput: 2, progress: 0.75 });

  atem.update({ programInput: 2, previewInput: 1, transitionPosition: NOT_MIXING });
  const snap = source.snapshot();
  assert.equal(snap.transition ?? null, null, "the mix clears when it ends");
  assert.equal(snap.programInput, 2);
  assert.equal(snap.previewInput, 1);
});

test("a mix already under way at connect plays out unblended; the next one blends", async () => {
  const state = seedState();
  state.video = { mixEffects: [{ programInput: 1, previewInput: 3, transitionPosition: mixing(4000) }] };
  const atem = new MiniAtem(state);
  const source = new AtemSource(atem);
  source.connect("10.0.0.5");
  await once(atem, "connected");
  assert.equal(source.snapshot().transition ?? null, null, "incoming unknown at connect");

  atem.update({ transitionPosition: mixing(8000) });
  assert.equal(source.snapshot().transition ?? null, null, "still no guess mid-mix");

  atem.update({ programInput: 2, previewInput: 3, transitionPosition: NOT_MIXING });
  assert.equal(source.snapshot().transition ?? null, null);

  atem.update({ previewInput: 2, transitionPosition: mixing(0) });
  assert.deepEqual(source.snapshot().transition, { incomingInput: 3, progress: 0 }, "the next mix blends");
});

test("a mix under way when the link reconnects plays out unblended", async () => {
  const atem = new MiniAtem(seedState()); // program 1, preview 2
  const source = new AtemSource(atem);
  source.connect("10.0.0.5");
  await once(atem, "connected");

  atem.emit("disconnected");
  // While we were away a mix of 2 started and preview moved on to 1.
  Object.assign(atem.state.video!.mixEffects![0]!, { previewInput: 1, transitionPosition: mixing(3000) });
  atem.emit("connected");
  assert.equal(source.snapshot().transition ?? null, null);

  atem.update({ transitionPosition: mixing(6000) });
  assert.equal(source.snapshot().transition ?? null, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { canReset, canStart, firmwareOutdated, type FlashState, type FlashTarget } from "./flasher";

const reported = (version: string) => ({ kind: "reported", version }) as const;

test("a light reporting older firmware than the app bundles is offered the update", () => {
	assert.equal(firmwareOutdated("1.2.0", reported("1.1.0")), true);
	// Versions compare numerically, not as strings.
	assert.equal(firmwareOutdated("1.10.0", reported("1.9.0")), true);
});

test("a legacy light (connected without reporting a version, so pre-1.1) is offered the update", () => {
	assert.equal(firmwareOutdated("1.2.0", { kind: "legacy" }), true);
});

test("a light on the bundled firmware or newer is not offered an update", () => {
	assert.equal(firmwareOutdated("1.2.0", reported("1.2.0")), false);
	assert.equal(firmwareOutdated("1.2.0", reported("1.3.0")), false);
	assert.equal(firmwareOutdated("1.9.0", reported("1.10.0")), false);
});

test("a light reporting a version that isn't x.y.z is offered the update, not read as current", () => {
	assert.equal(firmwareOutdated("1.2.0", reported("garbage")), true);
	assert.equal(firmwareOutdated("1.2.0", reported("1.2")), true);
	assert.equal(firmwareOutdated("1.2.0", reported("")), true);
});

test("a light not yet heard from is not offered an update", () => {
	assert.equal(firmwareOutdated("1.2.0", { kind: "unknown" }), false);
});

test("nothing is offered when the app bundles no firmware", () => {
	assert.equal(firmwareOutdated(null, reported("1.0.0")), false);
	assert.equal(firmwareOutdated(null, { kind: "legacy" }), false);
	assert.equal(firmwareOutdated(null, { kind: "unknown" }), false);
});

const target: FlashTarget = { kind: "blank", port: "/dev/ttyACM0" };
const settled: FlashState[] = [
	{ status: "idle" },
	{ status: "done", target, mac: "aa:bb:cc:dd:ee:ff" },
	{ status: "failed", target, stage: "write", failure: "unplugged", detail: "", leavesBlank: true },
	{ status: "cancelled", target, stage: "erase", leavesBlank: true },
];
const running: FlashState = { status: "running", target, stage: "write", progress: 0.5, leavesBlank: true };

test("a flash can't be started or reset while one runs", () => {
	assert.equal(canStart(running), false);
	assert.equal(canReset(running), false);
});

test("a flash can be started, or the outcome reset, once none is running", () => {
	for (const state of settled) {
		assert.equal(canStart(state), true, state.status);
		assert.equal(canReset(state), true, state.status);
	}
});

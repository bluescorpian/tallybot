import { test } from "node:test";
import assert from "node:assert/strict";
import { firmwareOutdated } from "./flasher";

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

test("a light not yet heard from is not offered an update", () => {
	assert.equal(firmwareOutdated("1.2.0", { kind: "unknown" }), false);
});

test("nothing is offered when the app bundles no firmware", () => {
	assert.equal(firmwareOutdated(null, reported("1.0.0")), false);
	assert.equal(firmwareOutdated(null, { kind: "legacy" }), false);
	assert.equal(firmwareOutdated(null, { kind: "unknown" }), false);
});

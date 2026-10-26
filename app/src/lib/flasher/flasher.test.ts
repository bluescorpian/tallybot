import { test } from "node:test";
import assert from "node:assert/strict";
import { firmwareOutdated } from "./flasher";

test("a light running older firmware than the app bundles is offered the update", () => {
	assert.equal(firmwareOutdated("1.2.0", { version: "1.1.0", known: true }), true);
	// Versions compare numerically, not as strings.
	assert.equal(firmwareOutdated("1.10.0", { version: "1.9.0", known: true }), true);
});

test("a light that connected without reporting a version runs pre-1.1 firmware and is offered the update", () => {
	assert.equal(firmwareOutdated("1.2.0", { version: null, known: true }), true);
});

test("a light on the bundled firmware or newer is not offered an update", () => {
	assert.equal(firmwareOutdated("1.2.0", { version: "1.2.0", known: true }), false);
	assert.equal(firmwareOutdated("1.2.0", { version: "1.3.0", known: true }), false);
	assert.equal(firmwareOutdated("1.9.0", { version: "1.10.0", known: true }), false);
});

test("a light not yet heard from is not offered an update", () => {
	assert.equal(firmwareOutdated("1.2.0", { version: null, known: false }), false);
});

test("nothing is offered when the app bundles no firmware", () => {
	assert.equal(firmwareOutdated(null, { version: "1.0.0", known: true }), false);
	assert.equal(firmwareOutdated(null, { version: null, known: true }), false);
});

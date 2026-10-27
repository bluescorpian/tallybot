// The shell→UI contracts, UI side: the hand-written types for what the Rust shell sends (flash
// jobs, the updater, health) against `src-tauri/contracts/shell-contracts.json`, which the shell's
// own tests serialise against too. Each `*_KEYS` record is checked by `pnpm check` to name exactly
// its type's fields; this test checks the fixture has exactly those fields and vocabulary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FLASH_FAILURES, FLASH_STAGES } from "./flasher/flasher";
import { UPDATE_PHASES } from "./updater/updater";
import type { FlashStatus } from "./flasher/tauri.svelte";
import type { UpdateInfo, UpdateProgress, UpdateStatus } from "./updater/tauri.svelte";
import type { ShellHealth } from "./ipc.svelte";

const contracts = JSON.parse(readFileSync(new URL("../../src-tauri/contracts/shell-contracts.json", import.meta.url), "utf8"));

type Keys<T> = Record<keyof T, true>;
type Variant<S extends FlashStatus["status"]> = Extract<FlashStatus, { status: S }>;

const FLASH_STATUS_KEYS = {
	running: { revision: true, port: true, targetMac: true, leavesBlank: true, status: true, stage: true, progress: true } satisfies Keys<Variant<"running">>,
	done: { revision: true, port: true, targetMac: true, leavesBlank: true, status: true, mac: true } satisfies Keys<Variant<"done">>,
	failed: {
		revision: true,
		port: true,
		targetMac: true,
		leavesBlank: true,
		status: true,
		stage: true,
		failure: true,
		detail: true,
	} satisfies Keys<Variant<"failed">>,
	cancelled: { revision: true, port: true, targetMac: true, leavesBlank: true, status: true, stage: true } satisfies Keys<Variant<"cancelled">>,
} satisfies Record<FlashStatus["status"], object>;

const HEALTH_KEYS = {
	revision: true,
	sidecarDown: true,
	usbPortErrors: true,
	unflashedPorts: true,
	lightPorts: true,
	blankLights: true,
	configDirMissing: true,
} satisfies Keys<ShellHealth>;
const PORT_ERROR_KEYS = { port: true, message: true } satisfies Keys<ShellHealth["usbPortErrors"][number]>;
const LIGHT_PORT_KEYS = { mac: true, port: true } satisfies Keys<ShellHealth["lightPorts"][number]>;

const UPDATE_INFO_KEYS = {
	version: true,
	date: true,
	notes: true,
	firmwareVersion: true,
	installable: true,
	releaseUrl: true,
} satisfies Keys<UpdateInfo>;
const UPDATE_STATUS_KEYS = { revision: true, failure: true } satisfies Keys<UpdateStatus>;
const UPDATE_FAILURE_KEYS = { phase: true, version: true, message: true } satisfies Keys<NonNullable<UpdateStatus["failure"]>>;
const UPDATE_PROGRESS_KEYS = { received: true, total: true } satisfies Keys<UpdateProgress>;

function sameKeys(value: object, keys: object, what: string): void {
	assert.deepEqual(Object.keys(value).sort(), Object.keys(keys).sort(), what);
}

test("the flash vocabulary is the shell's", () => {
	assert.deepEqual([...FLASH_STAGES], contracts.flashStages);
	assert.deepEqual([...FLASH_FAILURES], contracts.flashFailures);
});

test("every flash job status has the fields FlashStatus names", () => {
	const seen = new Set<string>();
	for (const s of contracts.flashStatus) {
		const keys = FLASH_STATUS_KEYS[s.status as FlashStatus["status"]];
		assert.ok(keys, `unknown status ${s.status}`);
		seen.add(s.status);
		sameKeys(s, keys, s.status);
		if ("stage" in s) assert.ok(FLASH_STAGES.includes(s.stage), s.stage);
		if ("failure" in s) assert.ok(FLASH_FAILURES.includes(s.failure), s.failure);
	}
	assert.deepEqual([...seen].sort(), Object.keys(FLASH_STATUS_KEYS).sort(), "every status has a fixture");
});

test("the firmware manifest has the field the UI reads", () => {
	assert.equal(typeof contracts.firmwareInfo.version, "string");
});

test("the health snapshot has the fields ShellHealth names", () => {
	const h = contracts.health;
	sameKeys(h, HEALTH_KEYS, "health");
	for (const e of h.usbPortErrors) sameKeys(e, PORT_ERROR_KEYS, "usbPortErrors");
	for (const l of [...h.lightPorts, ...h.blankLights]) sameKeys(l, LIGHT_PORT_KEYS, "lightPorts/blankLights");
});

test("the updater payloads have the fields and phases the UI names", () => {
	assert.deepEqual([...UPDATE_PHASES], contracts.updatePhases);
	sameKeys(contracts.updateInfo, UPDATE_INFO_KEYS, "updateInfo");
	sameKeys(contracts.updateStatus, UPDATE_STATUS_KEYS, "updateStatus");
	sameKeys(contracts.updateStatus.failure, UPDATE_FAILURE_KEYS, "updateStatus.failure");
	sameKeys(contracts.updateProgress, UPDATE_PROGRESS_KEYS, "updateProgress");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadProgress, downloadable, newerFirmwareUpdate, releaseNotes, type AppUpdate } from "./updater";
import { formatReleaseDate } from "../format/time";

const update = (over: Partial<AppUpdate> = {}): AppUpdate => ({
	version: "1.3.0",
	firmwareVersion: "1.2.0",
	date: "2026-10-01T09:00:00Z",
	notes: [],
	sizeBytes: 200,
	installable: true,
	releaseUrl: "https://github.com/example/tallybot/releases/tag/v1.3.0",
	...over,
});

test("release notes are the body's bullet lines, without GitHub's generated author and PR suffix", () => {
	// GitHub serves release bodies with CRLF line endings.
	const body = [
		"## What's Changed",
		"* Update a light's firmware from the app by @harry in https://github.com/example/tallybot/pull/41",
		"- Lights rejoin faster after a restart",
		"",
		"This release also tidies the settings page.",
		"",
		"**Full Changelog**: https://github.com/example/tallybot/compare/v1.2.0...v1.3.0",
	].join("\r\n");
	assert.deepEqual(releaseNotes(body), [
		"Update a light's firmware from the app",
		"Lights rejoin faster after a restart",
	]);
});

test("an update is surfaced for firmware only when it carries newer firmware than the app's", () => {
	const u = update({ firmwareVersion: "1.2.0" });
	assert.equal(newerFirmwareUpdate({ status: "available", update: u }, "1.1.0"), u);
	assert.equal(newerFirmwareUpdate({ status: "ready", update: u }, "1.1.0"), u);
	assert.equal(newerFirmwareUpdate({ status: "available", update: u }, "1.2.0"), null);
	assert.equal(newerFirmwareUpdate({ status: "available", update: u }, "1.3.0"), null);
	assert.equal(newerFirmwareUpdate({ status: "available", update: u }, null), null);
	assert.equal(newerFirmwareUpdate({ status: "current" }, "1.1.0"), null);
});

test("download progress is 0 until the size is known, and never passes 1", () => {
	assert.equal(downloadProgress(50, update({ sizeBytes: null })), 0);
	assert.equal(downloadProgress(50, update({ sizeBytes: 200 })), 0.25);
	assert.equal(downloadProgress(300, update({ sizeBytes: 200 })), 1);
});

test("a release's publish instant shows as the user's local date, and a missing or bad one shows none", () => {
	// `pnpm test` pins TZ so the instant below falls on a different calendar day locally than in UTC.
	assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/Los_Angeles");
	// 03:00 UTC on the 20th is still the evening of the 19th in Los Angeles.
	const shown = formatReleaseDate("2026-10-20T03:00:00Z");
	assert.match(shown ?? "", /\b19\b/, `local day, not the UTC one: ${shown}`);
	assert.doesNotMatch(shown ?? "", /\b20\b/, `local day, not the UTC one: ${shown}`);
	assert.match(shown ?? "", /\b2026\b/);

	assert.equal(formatReleaseDate(null), null);
	assert.equal(formatReleaseDate("not a date"), null, "never 'Invalid Date'");
});

test("an installable update can be downloaded; one that isn't installable, or is already downloading, can't", () => {
	const u = update({ installable: true });
	assert.equal(downloadable({ status: "available", update: u }), u);
	assert.equal(downloadable({ status: "available", update: update({ installable: false }) }), null);
	assert.equal(downloadable({ status: "downloading", update: u, received: 10 }), null);
	assert.equal(downloadable({ status: "current" }), null);
});

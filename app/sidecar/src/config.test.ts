import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { loadRuntimeConfig, xdgStateFile } from "./config.ts";

const DEFAULT = join("/default", "state.json");

test("TALLYBOT_STATE_FILE overrides the entry's default, and the log sits beside it", () => {
  const stateFile = join("/override", "dir", "state.json");
  assert.deepEqual(loadRuntimeConfig({ TALLYBOT_STATE_FILE: stateFile }, DEFAULT), {
    stateFile,
    logFile: join("/override", "dir", "sidecar.log"),
  });
});

test("an unset or empty TALLYBOT_STATE_FILE falls back to the entry's default", () => {
  const expected = { stateFile: DEFAULT, logFile: join("/default", "sidecar.log") };
  assert.deepEqual(loadRuntimeConfig({}, DEFAULT), expected);
  assert.deepEqual(loadRuntimeConfig({ TALLYBOT_STATE_FILE: "" }, DEFAULT), expected);
});

test("the standalone default uses an absolute XDG_STATE_HOME, else ~/.local/state", () => {
  const home = join("/home", "op");
  const fallback = join(home, ".local", "state", "tallybot", "state.json");
  assert.equal(xdgStateFile({ XDG_STATE_HOME: join("/xdg") }, home), join("/xdg", "tallybot", "state.json"));
  assert.equal(xdgStateFile({}, home), fallback);
  assert.equal(xdgStateFile({ XDG_STATE_HOME: "" }, home), fallback);
  assert.equal(xdgStateFile({ XDG_STATE_HOME: "relative/state" }, home), fallback);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore } from "./store.ts";
import { DEFAULT_BRIGHTNESS } from "./protocol.ts";

/** Run `body` with a fresh state-file path in a throwaway directory. */
async function withTempFile(body: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tallybot-store-"));
  try {
    await body(join(dir, "state.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a missing file loads as empty defaults", async () => {
  await withTempFile(async (path) => {
    const store = await ConfigStore.load(path);
    assert.equal(store.sourceIp, null);
    assert.deepEqual(store.devices(), []);
  });
});

test("assignments and the source IP round-trip across a reload", async () => {
  await withTempFile(async (path) => {
    const store = await ConfigStore.load(path);
    await store.setSourceIp("10.0.0.5");
    await store.assign("aa:bb:cc:dd:ee:ff", 2);
    await store.setBrightness("aa:bb:cc:dd:ee:ff", 200);

    const reloaded = await ConfigStore.load(path);
    assert.equal(reloaded.sourceIp, "10.0.0.5");
    assert.deepEqual(reloaded.device("aa:bb:cc:dd:ee:ff"), { inputId: 2, brightness: 200 });
  });
});

test("unassigning keeps the device's brightness but clears the input", async () => {
  await withTempFile(async (path) => {
    const store = await ConfigStore.load(path);
    await store.assign("aa:bb:cc:dd:ee:ff", 3);
    await store.setBrightness("aa:bb:cc:dd:ee:ff", 64);
    await store.unassign("aa:bb:cc:dd:ee:ff");

    const reloaded = await ConfigStore.load(path);
    assert.deepEqual(reloaded.device("aa:bb:cc:dd:ee:ff"), { inputId: null, brightness: 64 });
  });
});

test("brightness is clamped to a 0–255 byte", async () => {
  await withTempFile(async (path) => {
    const store = await ConfigStore.load(path);
    await store.setBrightness("aa:bb:cc:dd:ee:ff", 999);
    assert.equal(store.device("aa:bb:cc:dd:ee:ff")!.brightness, 255);
    await store.setBrightness("aa:bb:cc:dd:ee:ff", -10);
    assert.equal(store.device("aa:bb:cc:dd:ee:ff")!.brightness, 0);
  });
});

test("fully-default device entries are pruned from the file", async () => {
  await withTempFile(async (path) => {
    const store = await ConfigStore.load(path);
    // Touch a device then return it to defaults: it should not be persisted.
    await store.assign("aa:bb:cc:dd:ee:ff", 1);
    await store.unassign("aa:bb:cc:dd:ee:ff"); // inputId null, brightness still default
    await store.flush();

    const onDisk = JSON.parse(await readFile(path, "utf8")) as { devices: Record<string, unknown> };
    assert.deepEqual(onDisk.devices, {}, "a device with no assignment and default brightness isn't stored");
  });
});

test("a corrupt file falls back to defaults instead of throwing", async () => {
  await withTempFile(async (path) => {
    await writeFile(path, "{ this is not json", "utf8");
    const store = await ConfigStore.load(path);
    assert.equal(store.sourceIp, null);
    assert.deepEqual(store.devices(), []);
  });
});

test("a partially-valid file salvages its good entries", async () => {
  await withTempFile(async (path) => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        sourceIp: "10.0.0.9",
        devices: {
          "aa:bb:cc:dd:ee:ff": { inputId: 4, brightness: 100 }, // good
          "11:22:33:44:55:66": "garbage", // bad — dropped
          "77:88:99:aa:bb:cc": { inputId: "nope" }, // partial — brightness defaults
        },
      }),
      "utf8",
    );
    const store = await ConfigStore.load(path);
    assert.equal(store.sourceIp, "10.0.0.9");
    assert.deepEqual(store.device("aa:bb:cc:dd:ee:ff"), { inputId: 4, brightness: 100 });
    assert.equal(store.device("11:22:33:44:55:66"), undefined);
    assert.deepEqual(store.device("77:88:99:aa:bb:cc"), { inputId: null, brightness: DEFAULT_BRIGHTNESS });
  });
});

test("an atomic write leaves no stray temp file behind", async () => {
  await withTempFile(async (path) => {
    const store = await ConfigStore.load(path);
    await store.assign("aa:bb:cc:dd:ee:ff", 1);
    await store.flush();
    await assert.rejects(readFile(`${path}.tmp`, "utf8"), /ENOENT/, "the temp file should be renamed away");
  });
});

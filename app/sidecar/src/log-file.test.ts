import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RotatingLogFile } from "./log-file.ts";

/** Run `body` with a fresh directory that is removed afterwards. */
async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tallybot-log-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

test("lines are appended asynchronously, each with a timestamp", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "sidecar.log");
    const log = new RotatingLogFile(path, { maxBytes: 1024 * 1024, keep: 2 });

    log.write("first");
    log.write("second");
    // write() returned before anything reached the file.
    assert.equal(existsSync(path), false);

    await log.flush();
    const written = lines(await readFile(path, "utf8"));
    assert.equal(written.length, 2);
    for (const line of written) assert.match(line, TIMESTAMP);
    assert.ok(written[0]!.endsWith(" first"));
    assert.ok(written[1]!.endsWith(" second"));
  });
});

test("past the size cap the live file rotates and only `keep` old files are retained", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "sidecar.log");
    // Each line is well over half the cap, so every flushed line forces a rotation.
    const log = new RotatingLogFile(path, { maxBytes: 100, keep: 2 });
    const payload = "x".repeat(60);

    for (let i = 1; i <= 5; i++) {
      log.write(`line-${i} ${payload}`);
      await log.flush();
    }

    assert.deepEqual((await readdir(dir)).sort(), ["sidecar.log", "sidecar.log.1", "sidecar.log.2"]);
    // Newest in the live file, then shifting up by one per rotation; line-1 and line-2 are gone.
    assert.match(await readFile(path, "utf8"), /line-5 /);
    assert.match(await readFile(`${path}.1`, "utf8"), /line-4 /);
    assert.match(await readFile(`${path}.2`, "utf8"), /line-3 /);
  });
});

test("an unwritable path drops lines without throwing or hanging", async () => {
  await withTempDir(async (dir) => {
    // A regular file where the log's directory should be: mkdir and append both fail.
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "");
    const log = new RotatingLogFile(join(blocker, "sidecar.log"), { maxBytes: 1024, keep: 1 });

    assert.doesNotThrow(() => log.write("lost"));
    await log.flush();
    assert.doesNotThrow(() => log.write("also lost"));
    await log.flush();
  });
});

test("past the queue bound lines are dropped and a note records how many", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "sidecar.log");
    const log = new RotatingLogFile(path, { maxBytes: 1024 * 1024, keep: 1, maxPendingBytes: 300 });

    // A synchronous burst: the drain can't run between these, so the queue fills.
    const total = 50;
    for (let i = 0; i < total; i++) log.write(`burst-${i}`);
    await log.flush();

    const written = lines(await readFile(path, "utf8"));
    const kept = written.filter((l) => /burst-\d+$/.test(l)).length;
    assert.ok(kept < total, "some lines should have been dropped");
    const notes = written.filter((l) => !/burst-\d+$/.test(l));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, new RegExp(`\\b${total - kept}\\b.*dropped`));
  });
});

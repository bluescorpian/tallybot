#!/usr/bin/env node
/**
 * Boot check for a built sidecar: start it the way the Tauri shell does, and fail unless it
 * comes up and shuts down cleanly.
 *
 *   node smoke-boot.mjs <sidecar binary> [args…]
 *   node smoke-boot.mjs node --experimental-strip-types src/main.ts   # the same check on source
 *
 * The packaged binary (pkg runtime, esbuild bundle, the on-disk `atem-connection` worker tree) is
 * a different program from the source the tests run, and a release pushes itself to every
 * installed app through the updater, so release.yml runs this on each OS's binary before anything
 * is attached. It passes when: the first stdout line is the NDJSON `state` snapshot; the log file
 * appears beside `TALLYBOT_STATE_FILE` (a temp dir here); and closing stdin, which is how the
 * sidecar learns the shell has gone, makes it exit with code 0.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const BOOT_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node smoke-boot.mjs <sidecar binary> [args…]");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "tallybot-smoke-"));
const child = spawn(command, args, {
  env: { ...process.env, TALLYBOT_STATE_FILE: join(dir, "state.json") },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));

const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

function fail(message) {
  console.error(`smoke-boot: FAIL: ${message}`);
  if (stderr) console.error(`--- sidecar stderr ---\n${stderr.trimEnd()}`);
  child.kill();
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

child.on("error", (err) => fail(`couldn't start ${command}: ${err.message}`));

const firstLine = await Promise.race([
  new Promise((resolve) => createInterface({ input: child.stdout }).once("line", resolve)),
  exited.then(({ code, signal }) => ({ died: `exited before speaking (code ${code}, signal ${signal})` })),
  new Promise((resolve) => setTimeout(resolve, BOOT_TIMEOUT_MS, { died: `no stdout within ${BOOT_TIMEOUT_MS / 1000} s` })),
]);
if (typeof firstLine !== "string") fail(firstLine.died);

let message;
try {
  message = JSON.parse(firstLine);
} catch {
  fail(`first stdout line isn't JSON: ${firstLine.slice(0, 200)}`);
}
if (message?.type !== "state") fail(`first message is ${JSON.stringify(message?.type)}, not "state"`);
if (!existsSync(join(dir, "sidecar.log"))) {
  // The log is written asynchronously; give its first drain a moment.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (!existsSync(join(dir, "sidecar.log"))) fail("no sidecar.log beside the state file");
}

child.stdin.end();
const result = await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, EXIT_TIMEOUT_MS, null))]);
if (result === null) fail(`still running ${EXIT_TIMEOUT_MS / 1000} s after stdin closed`);
if (result.code !== 0) fail(`exited with code ${result.code}, signal ${result.signal} after stdin closed`);

rmSync(dir, { recursive: true, force: true });
console.log("smoke-boot: ok (state snapshot, log file, clean exit on stdin EOF)");
process.exit(0); // the boot and exit timers are still pending

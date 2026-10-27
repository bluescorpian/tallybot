/**
 * Entry point — the production wiring.
 *
 * This is the only file that touches the real `atem-connection` library; everything
 * downstream depends on the {@link AtemLike} seam, so the heavy dependency lives at
 * the very edge. It loads the saved config, picks the real ATEM, the log sink and the
 * state path, hands them to {@link createSidecar} (`src/wiring.ts`, the composition root
 * every entry shares), and manages start-up / shutdown. Hardware-free runs use the
 * `FakeAtem` instead (see `tools/`), which is why this file is deliberately
 * thin: there is almost nothing here that the orchestrator's tests don't already cover.
 *
 * stdout is reserved for the NDJSON protocol (`src/ipc.ts`); all logging goes to
 * stderr, and is also kept in a rotating diagnostic log file beside the state file
 * (`src/log-file.ts`) — the release build has no console, so that file is the only
 * after-the-show record of why a light dropped.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { format } from "node:util";

import { Atem } from "atem-connection";

import { type AtemLike, AtemSource } from "./atem.ts";
import { IpcBridge } from "./ipc-bridge.ts";
import { RotatingLogFile } from "./log-file.ts";
import { macTail } from "./protocol.ts";
import { scanNetwork } from "./scanner.ts";
import { ConfigStore } from "./store.ts";
import { createSidecar, runUntilClosed } from "./wiring.ts";

/**
 * Where the persisted config lives. `TALLYBOT_STATE_FILE` wins (the Tauri shell sets it
 * to a path in the OS app-config dir); otherwise an XDG-style per-user path, which only
 * standalone runs use.
 */
function stateFilePath(): string {
  const override = process.env["TALLYBOT_STATE_FILE"];
  if (override) return override;
  const base = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  return join(base, "tallybot", "state.json");
}

/**
 * The diagnostic log sits beside the state file, so the packaged app's lands in the same
 * app-config dir the Tauri shell points `TALLYBOT_STATE_FILE` at (`src-tauri/src/sidecar.rs`).
 */
function logFilePath(): string {
  return join(dirname(stateFilePath()), "sidecar.log");
}

/**
 * The busiest steady writer is an ESP-NOW bridge's once-a-second summary (~170 bytes with
 * the timestamp): ~0.6 MB an hour, ~10 MB over a 16-hour show day. 5 MB × (live + 4 rotated)
 * keeps about 40 hours of it — a whole day plus the one before — in at most 25 MB.
 */
const LOG_ROTATION = { maxBytes: 5 * 1024 * 1024, keep: 4 };

// stdout is the NDJSON IPC channel the Tauri shell parses; one stray library log line on
// it corrupts the stream. `atem-connection`/`threadedClass` log via console.log/info/debug,
// so route those to stderr before any Atem is constructed (the adapter below, and the
// scanner). (ARCHITECTURE "Packaging the Sidecar", warning 2.) Every console method also
// goes through `diag`, so library warnings and errors land in the log file too.
const logFile = new RotatingLogFile(logFilePath(), LOG_ROTATION);

/** One diagnostic line: stderr as before, plus the timestamped log file. */
function diag(line: string): void {
  process.stderr.write(`${line}\n`);
  logFile.write(line);
}

const logToDiag = (...args: unknown[]): void => diag(format(...args));
console.log = logToDiag;
console.info = logToDiag;
console.debug = logToDiag;
console.warn = logToDiag;
console.error = logToDiag;

/** Exit once the log file has the last lines — but never let a stuck disk hold the exit up. */
function exitAfterFlush(code: number): void {
  const exit = (): never => process.exit(code);
  setTimeout(exit, 1000).unref();
  void logFile.flush().then(exit);
}

async function main(): Promise<void> {
  diag(`tallybot sidecar starting (pid ${process.pid}); log file ${logFile.path}`);
  const store = await ConfigStore.load(stateFilePath());

  // The real Atem's typings are broader than the slice we use; the AtemLike seam is
  // the single point that absorbs that, so the rest of the sidecar stays library-free.
  const atem = new AtemSource(new Atem() as unknown as AtemLike);
  const ipc = new IpcBridge();

  const { app, deviceServer } = createSidecar({ atem, ipc, store, log: diag, scanNetwork });

  // Every device line, INFO included (a bridge's 1 s summary is what shows a relay outage), goes
  // to the file only: the UI already gets them as `deviceLog`, and at one a second they would
  // drown everything else on stderr.
  deviceServer.on("log", ({ mac, level, text }) => logFile.write(`[device ${macTail(mac)}] ${level}: ${text}`));

  await app.start();
  diag("tallybot sidecar started");

  runUntilClosed(app, {
    log: diag,
    onExit: () => {
      diag("tallybot sidecar stopped");
      exitAfterFlush(0);
    },
  });
}

main().catch((err: unknown) => {
  diag(`fatal: ${(err as Error).stack ?? String(err)}`);
  exitAfterFlush(1);
});

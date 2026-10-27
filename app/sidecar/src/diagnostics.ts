/**
 * The sidecar process's diagnostic channel: stderr plus the rotating log file.
 *
 * Shared by the production entry and the `cargo tauri dev` fake-ATEM entry, so dev writes the
 * same `sidecar.log` the release build depends on. The release build has no console, so that
 * file is the only after-the-show record of why a light dropped.
 */

import { format } from "node:util";

import { RotatingLogFile } from "./log-file.ts";

/**
 * The busiest steady writer is an ESP-NOW bridge's once-a-second summary (~170 bytes with
 * the timestamp): ~0.6 MB an hour, ~10 MB over a 16-hour show day. 5 MB × (live + 4 rotated)
 * keeps about 40 hours of it — a whole day plus the one before — in at most 25 MB.
 */
const LOG_ROTATION = { maxBytes: 5 * 1024 * 1024, keep: 4 };

export interface Diagnostics {
  readonly logFile: RotatingLogFile;
  /** One diagnostic line: stderr, plus the timestamped log file. */
  diag(line: string): void;
  /** Exit once the log file has the last lines, but never let a stuck disk hold the exit up. */
  exitAfterFlush(code: number): void;
}

/** A thrown value as a `fatal:` line's text: the stack when there is one. */
export function describeFatal(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * Open the log at `logPath`, route every `console` method through {@link Diagnostics.diag}, and
 * make an uncaught exception or unhandled rejection a recorded exit.
 *
 * stdout is the NDJSON IPC channel the Tauri shell parses; one stray library log line on it
 * corrupts the stream. `atem-connection`/`threadedClass` log via console.log/info/debug, so call
 * this before any Atem is constructed (ARCHITECTURE "Packaging the Sidecar", warning 2). Library
 * warnings and errors then land in the log file too.
 */
export function startDiagnostics(logPath: string): Diagnostics {
  const logFile = new RotatingLogFile(logPath, LOG_ROTATION);

  const diag = (line: string): void => {
    process.stderr.write(`${line}\n`);
    logFile.write(line);
  };

  const logToDiag = (...args: unknown[]): void => diag(format(...args));
  console.log = logToDiag;
  console.info = logToDiag;
  console.debug = logToDiag;
  console.warn = logToDiag;
  console.error = logToDiag;

  const exitAfterFlush = (code: number): void => {
    const exit = (): never => process.exit(code);
    setTimeout(exit, 1000).unref();
    void logFile.flush().then(exit);
  };

  // Node's own handler for these prints to fd 2 and exits at once, bypassing `diag`, so the log
  // file (the release build's only record) would never say why the engine died. Record it as a
  // `fatal:` line (the shell shows its first line in the "engine stopped" banner) and exit after
  // the flush. Exiting is still right: after an unexpected throw the engine's state can't be
  // trusted, and the shell restarts it.
  let dying = false;
  const fatal = (kind: string) => (err: unknown): void => {
    if (dying) return; // a second failure while flushing is noise; the first is the cause
    dying = true;
    diag(`fatal: ${kind}: ${describeFatal(err)}`);
    exitAfterFlush(1);
  };
  process.on("uncaughtException", fatal("uncaught exception"));
  process.on("unhandledRejection", fatal("unhandled rejection"));

  return { logFile, diag, exitAfterFlush };
}

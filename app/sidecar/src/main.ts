/**
 * Entry point — the production wiring.
 *
 * This is the only file that touches the real `atem-connection` library; everything
 * downstream depends on the {@link AtemLike} seam, so the heavy dependency lives at
 * the very edge. It loads the saved config, constructs the four pieces, hands them
 * to the orchestrator, and manages start-up / shutdown. Hardware-free runs use the
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

import { SidecarApp } from "./app.ts";
import { type AtemLike, AtemSource } from "./atem.ts";
import { CompositeDeviceServer } from "./composite-device-server.ts";
import { DeviceServer } from "./device-server.ts";
import { EspNowTransport } from "./espnow-transport.ts";
import { IpcBridge } from "./ipc-bridge.ts";
import { RotatingLogFile } from "./log-file.ts";
import { macTail } from "./protocol.ts";
import { ConfigStore } from "./store.ts";
import { UsbTransport } from "./usb-transport.ts";

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

  // The device server fans out over three transports, in priority order — USB wins when a MAC is
  // on more than one (a light cabled for re-provisioning dedupes to its USB presence). The USB
  // transport rides the same shell↔sidecar bridge `ipc` owns; the shell owns the port. The
  // ESP-NOW transport rides *on top of* USB: relayed lights reach the host through the bridge's
  // cable (see `docs/architecture.md`, "ESP-NOW transport").
  const tcp = new DeviceServer();
  const usb = new UsbTransport(ipc);
  const espnow = new EspNowTransport(usb);
  const deviceServer = new CompositeDeviceServer(
    [
      { transport: "usb", port: usb },
      { transport: "wifi", port: tcp },
      { transport: "espnow", port: espnow },
    ],
    usb,
  );

  // Every device line, INFO included (a bridge's 1 s summary is what shows a relay outage), goes
  // to the file only: the UI already gets them as `deviceLog`, and at one a second they would
  // drown everything else on stderr.
  deviceServer.on("log", ({ mac, level, text }) => logFile.write(`[device ${macTail(mac)}] ${level}: ${text}`));

  const app = new SidecarApp({ atem, deviceServer, provisioning: deviceServer, espnow, store, ipc, log: diag });
  await app.start();
  diag("tallybot sidecar started");

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app
      .stop()
      .catch((err: unknown) => diag(`shutdown error: ${(err as Error).message}`))
      .finally(() => {
        diag("tallybot sidecar stopped");
        exitAfterFlush(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The shell owns our stdin: EOF means it died or was killed without running its
  // exit hook. Exit too, or the orphan keeps TCP 7000 / UDP 7001 bound and the next
  // launch can't start.
  process.stdin.on("end", shutdown);
}

main().catch((err: unknown) => {
  diag(`fatal: ${(err as Error).stack ?? String(err)}`);
  exitAfterFlush(1);
});

/**
 * Entry point — the production wiring.
 *
 * The real `atem-connection` library is reached only from the entries: here directly,
 * and through the `scanner.ts` sweep they inject. Everything downstream depends on the
 * {@link AtemLike} seam and an injected `scanNetwork`, so the heavy dependency lives at
 * the very edge. It loads the saved config, picks the real ATEM, the log sink and the
 * state path, hands them to {@link createSidecar} (`src/wiring.ts`, the composition root
 * every entry shares), and manages start-up / shutdown. Hardware-free runs use the
 * `FakeAtem` instead (see `tools/`), which is why this file is deliberately
 * thin: there is almost nothing here that the orchestrator's tests don't already cover.
 *
 * stdout is reserved for the NDJSON protocol (`src/ipc.ts`); all logging goes to
 * stderr and the rotating diagnostic log beside the state file (`src/diagnostics.ts`).
 */

import { Atem } from "atem-connection";

import { type AtemLike, AtemSource } from "./atem.ts";
import { loadRuntimeConfig, xdgStateFile } from "./config.ts";
import { describeFatal, startDiagnostics } from "./diagnostics.ts";
import { IpcBridge } from "./ipc-bridge.ts";
import { macTail } from "./protocol.ts";
import { scanNetwork } from "./scanner.ts";
import { ConfigStore } from "./store.ts";
import { createSidecar, runUntilClosed } from "./wiring.ts";

// The shell points `TALLYBOT_STATE_FILE` at the OS app-config dir; a standalone run falls back to
// the XDG state dir. The log goes beside the state file either way (`src/config.ts`).
const config = loadRuntimeConfig(process.env, xdgStateFile(process.env));

// Before any Atem is constructed: it routes the library's console output off stdout.
const { logFile, diag, exitAfterFlush } = startDiagnostics(config.logFile);

async function main(): Promise<void> {
  diag(`tallybot sidecar starting (pid ${process.pid}); log file ${logFile.path}`);
  const store = await ConfigStore.load(config.stateFile);

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
  diag(`fatal: ${describeFatal(err)}`);
  exitAfterFlush(1);
});

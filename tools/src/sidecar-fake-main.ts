/**
 * Development entry point — the production sidecar wired to the fake ATEM.
 *
 * This is the dev-mode counterpart of `app/sidecar/src/main.ts`. It builds the brain
 * through the same composition root (`createSidecar`, `app/sidecar/src/wiring.ts`), so
 * the transports and orchestrator are wired identically by construction, and speaks the exact
 * same NDJSON-over-stdio protocol via the real {@link IpcBridge}, so the Tauri shell
 * can spawn it transparently in place of `main.ts`. The only differences: it drives a
 * Phase-1 {@link FakeAtem} instead of the real `atem-connection` library, marks every
 * snapshot `dev: true` so the UI makes the board's input keys clickable, and handles
 * the dev-only `setProgram` command by driving that fake ATEM.
 *
 * The Rust shell selects this entry for `cargo tauri dev` (debug builds) — see
 * `app/src-tauri/src/lib.rs`. It binds the real ports (TCP 7000 / UDP 7001), so real
 * ESP32 devices on the LAN connect normally; clicking the board's inputs then drives
 * live/preview tally onto them with no ATEM plugged in.
 *
 * Like the other tools it imports the real sidecar from `../../app/sidecar/src`; the
 * dependency direction stays tools → sidecar (the production sidecar never sees a fake).
 * stdout is reserved for the NDJSON protocol; all logging goes to stderr and `sidecar.log`.
 */

import { FakeAtem } from "./atem-sim.ts";
import { DEV_STATE_FILE } from "./dev-config.ts";

import { AtemSource } from "../../app/sidecar/src/atem.ts";
import { loadRuntimeConfig } from "../../app/sidecar/src/config.ts";
import { startDiagnostics } from "../../app/sidecar/src/diagnostics.ts";
import { IpcBridge } from "../../app/sidecar/src/ipc-bridge.ts";
import { macTail } from "../../app/sidecar/src/protocol.ts";
import { scanNetwork } from "../../app/sidecar/src/scanner.ts";
import { ConfigStore } from "../../app/sidecar/src/store.ts";
import { createSidecar, runUntilClosed } from "../../app/sidecar/src/wiring.ts";

// `TALLYBOT_STATE_FILE` wins; otherwise the dev tmpdir state. The log goes beside it, as in production.
const config = loadRuntimeConfig(process.env, DEV_STATE_FILE);

// The same diagnostic channel as `main.ts`: stdout stays NDJSON-only, and dev writes the
// `sidecar.log` the release build depends on.
const { logFile, diag, exitAfterFlush } = startDiagnostics(config.logFile);

async function main(): Promise<void> {
  const store = await ConfigStore.load(config.stateFile);

  const fakeAtem = new FakeAtem({ inputCount: 4, programInput: 1, previewInput: 2 });
  const atem = new AtemSource(fakeAtem);
  const ipc = new IpcBridge();

  // The same composition root as production (`wiring.ts`): USB provisioning, a real ESP32-C3 on
  // USB (relayed by the Rust shell) alongside LAN devices, and the ESP-NOW transport, so a bridge
  // + relayed lights work in dev exactly as in production.
  const { app, deviceServer } = createSidecar({ atem, ipc, store, log: diag, scanNetwork, dev: true });

  // Dev-only: mirror device TLOG lines (USB LOG frames) to stderr as well as the log file, so
  // firmware-side events (bridge enter/exit, session loss, every SET_COLOR rendered) show in the
  // `cargo tauri dev` terminal alongside the sidecar's own logs; production writes them to the
  // file only.
  deviceServer.on("log", ({ mac, level, text }) => diag(`[device ${macTail(mac)}] ${level}: ${text.trimEnd()}`));

  // Dev-only: drive the fake ATEM's program from the UI. Clicking an input takes it to
  // air; the previously-live input drops to preview (a swap, as on a real ME cut). This
  // listener lives alongside SidecarApp's own command handler (which ignores setProgram).
  ipc.on("command", (command) => {
    if (command.type !== "setProgram") return;
    const me = fakeAtem.state.video.mixEffects[0];
    if (!me || command.inputId === me.programInput) return; // no-op on the current program
    void fakeAtem.changePreviewInput(me.programInput); // old program → preview
    void fakeAtem.changeProgramInput(command.inputId); // clicked → program
  });

  await app.start();
  // Bring the fake ATEM online (its IP is irrelevant — the sim has no network).
  atem.connect("simulated");
  diag(`tallybot sidecar (dev/fake-ATEM) started; log file ${logFile.path}`);

  runUntilClosed(app, { log: diag, onExit: () => exitAfterFlush(0) });
}

main().catch((err: unknown) => {
  diag(`fatal: ${(err as Error).stack ?? String(err)}`);
  exitAfterFlush(1);
});

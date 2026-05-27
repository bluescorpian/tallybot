/**
 * Entry point — the production wiring.
 *
 * This is the only file that touches the real `atem-connection` library; everything
 * downstream depends on the {@link AtemLike} seam, so the heavy dependency lives at
 * the very edge. It loads the saved config, constructs the four pieces, hands them
 * to the orchestrator, and manages start-up / shutdown. Hardware-free runs use the
 * Phase 1 `FakeAtem` instead (see `tools/`), which is why this file is deliberately
 * thin: there is almost nothing here that the orchestrator's tests don't already cover.
 *
 * stdout is reserved for the NDJSON protocol (`src/ipc.ts`); all logging goes to
 * stderr.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { Atem } from "atem-connection";

import { SidecarApp } from "./app.ts";
import { type AtemLike, AtemSource } from "./atem.ts";
import { DeviceServer } from "./device-server.ts";
import { IpcBridge } from "./ipc-bridge.ts";
import { ConfigStore } from "./store.ts";

/**
 * Where the persisted config lives. `TALLYBOT_STATE_FILE` wins; otherwise an
 * XDG-style per-user path. Phase 5 (the Tauri shell) will pass an explicit
 * app-data path, making the default below only matter for standalone runs.
 */
function stateFilePath(): string {
  const override = process.env["TALLYBOT_STATE_FILE"];
  if (override) return override;
  const base = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  return join(base, "tallybot", "state.json");
}

async function main(): Promise<void> {
  const store = await ConfigStore.load(stateFilePath());

  // The real Atem's typings are broader than the slice we use; the AtemLike seam is
  // the single point that absorbs that, so the rest of the sidecar stays library-free.
  const atem = new AtemSource(new Atem() as unknown as AtemLike);
  const deviceServer = new DeviceServer();
  const ipc = new IpcBridge();

  const app = new SidecarApp({ atem, deviceServer, store, ipc });
  await app.start();
  process.stderr.write("tallybot sidecar started\n");

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app
      .stop()
      .catch((err: unknown) => process.stderr.write(`shutdown error: ${(err as Error).message}\n`))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

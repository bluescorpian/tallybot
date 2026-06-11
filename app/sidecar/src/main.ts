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
import { CompositeDeviceServer } from "./composite-device-server.ts";
import { DeviceServer } from "./device-server.ts";
import { EspNowTransport } from "./espnow-transport.ts";
import { IpcBridge } from "./ipc-bridge.ts";
import { ConfigStore } from "./store.ts";
import { UsbTransport } from "./usb-transport.ts";

// stdout is the NDJSON IPC channel the Tauri shell parses; one stray library log line on
// it corrupts the stream. `atem-connection`/`threadedClass` log via console.log/info/debug,
// so route those to stderr before any Atem is constructed (the adapter below, and the
// scanner). console.warn/error already go to stderr. (ARCHITECTURE "Packaging the Sidecar",
// warning 2.)
const logToStderr = (...args: unknown[]): void => {
  process.stderr.write(`${args.map(String).join(" ")}\n`);
};
console.log = logToStderr;
console.info = logToStderr;
console.debug = logToStderr;

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
  const ipc = new IpcBridge();

  // The device server fans out over three transports, in priority order — USB wins when a MAC is
  // on more than one (a light cabled for re-provisioning dedupes to its USB presence). The USB
  // transport rides the same shell↔sidecar bridge `ipc` owns; the shell owns the port. The
  // ESP-NOW transport rides *on top of* USB: relayed lights reach the host through the bridge's
  // cable (see `docs/spec/esp-now-transport.md`).
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

  const app = new SidecarApp({ atem, deviceServer, provisioning: deviceServer, espnow, store, ipc });
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

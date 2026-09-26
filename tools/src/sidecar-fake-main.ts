/**
 * Development entry point — the production sidecar wired to the fake ATEM.
 *
 * This is the dev-mode counterpart of `app/sidecar/src/main.ts`. It constructs the
 * exact same brain (orchestrator, engine, device server, store) and speaks the exact
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
 * stdout is reserved for the NDJSON protocol; all logging goes to stderr.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeAtem } from "./atem-sim.ts";

import { SidecarApp } from "../../app/sidecar/src/app.ts";
import { AtemSource } from "../../app/sidecar/src/atem.ts";
import { CompositeDeviceServer } from "../../app/sidecar/src/composite-device-server.ts";
import { DeviceServer } from "../../app/sidecar/src/device-server.ts";
import { EspNowTransport } from "../../app/sidecar/src/espnow-transport.ts";
import { IpcBridge } from "../../app/sidecar/src/ipc-bridge.ts";
import { ConfigStore } from "../../app/sidecar/src/store.ts";
import { UsbTransport } from "../../app/sidecar/src/usb-transport.ts";

// stdout is the NDJSON IPC channel the Tauri shell parses; one stray library log line
// on it corrupts the stream. Route console.log/info/debug to stderr (warn/error already
// go there), mirroring main.ts.
const logToStderr = (...args: unknown[]): void => {
  process.stderr.write(`${args.map(String).join(" ")}\n`);
};
console.log = logToStderr;
console.info = logToStderr;
console.debug = logToStderr;

/**
 * Where the dev config lives. `TALLYBOT_STATE_FILE` wins; otherwise a tmpdir file kept
 * separate from production state so dev assignments never clobber a real config.
 */
function stateFilePath(): string {
  return process.env["TALLYBOT_STATE_FILE"] ?? join(tmpdir(), "tallybot-dev-state.json");
}

async function main(): Promise<void> {
  const store = await ConfigStore.load(stateFilePath());

  const fakeAtem = new FakeAtem({ inputCount: 4, programInput: 1, previewInput: 2 });
  const atem = new AtemSource(fakeAtem);
  const ipc = new IpcBridge();

  // Mirror production wiring so `cargo tauri dev` exercises USB provisioning too: a real
  // ESP32-C3 on USB (relayed by the Rust shell) shows up alongside LAN devices — and the
  // ESP-NOW transport, so a bridge + relayed lights work in dev exactly as in production.
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

  // Dev-only: mirror device TLOG lines (USB LOG frames) to stderr, so firmware-side events
  // (bridge enter/exit, session loss, every SET_COLOR rendered) show in the `cargo tauri dev`
  // terminal alongside the sidecar's own logs — production forwards them to the UI only.
  deviceServer.on("log", ({ mac, level, text }) => {
    process.stderr.write(`[device ${mac.slice(-5)}] ${level}: ${text.endsWith("\n") ? text : `${text}\n`}`);
  });

  const app = new SidecarApp({ atem, deviceServer, provisioning: deviceServer, espnow, store, ipc, dev: true });

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
  process.stderr.write("tallybot sidecar (dev/fake-ATEM) started\n");

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
  // The shell owns our stdin: EOF means it died or was killed without running its
  // exit hook. Exit too, or the orphan keeps TCP 7000 / UDP 7001 bound and the next
  // launch can't start.
  process.stdin.on("end", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

/**
 * The composition root: the one place the sidecar's device stack is assembled.
 *
 * Every entry — production `main.ts`, the `cargo tauri dev` fake-ATEM entry, the REPL runner
 * and the end-to-end test in `tools/` — calls {@link createSidecar}, so they differ only in what
 * they hand it (which ATEM, which IPC, where state and logs go) and never in how the transports,
 * the composite and the orchestrator are wired together. A new transport or `SidecarApp`
 * collaborator is added here once, and every entry gets it.
 */

import { type AtemSourcePort, type EspNowBridgePort, type IpcPort, SidecarApp, type StorePort } from "./app.ts";
import { type CompositeMember, CompositeDeviceServer } from "./composite-device-server.ts";
import { DeviceServer, type DeviceServerOptions } from "./device-server.ts";
import { EspNowTransport } from "./espnow-transport.ts";
import type { DeviceTransport, SourceScanHit } from "./ipc.ts";
import { type UsbBridgePort, UsbTransport } from "./usb-transport.ts";

/** Every transport, in priority order: the first member holding a MAC owns it. */
const ALL_TRANSPORTS: readonly DeviceTransport[] = ["usb", "wifi", "espnow"];

export interface SidecarInputs {
  atem: AtemSourcePort;
  /** The UI channel; it also carries the USB bridge the shell relays (the `IpcBridge` is both). */
  ipc: IpcPort & UsbBridgePort;
  store: StorePort;
  /** Where the orchestrator writes diagnostics. */
  log: (message: string) => void;
  /** The subnet sweep behind the settings "Scan". */
  scanNetwork: (log: (message: string) => void) => Promise<SourceScanHit[]>;
  /** Mark every snapshot as dev mode (the fake-ATEM entry only). */
  dev?: boolean;
  /**
   * Which transports to run (default all three). Order here is irrelevant; the composite always
   * ranks them usb > wifi > espnow. ESP-NOW rides on USB, so it needs `"usb"` too. Without USB
   * the composite's provisioning methods all return false.
   */
  transports?: readonly DeviceTransport[];
  /** Options for the TCP/UDP device server (ports, bind host); defaults bind the real 7000/7001. */
  tcp?: DeviceServerOptions;
}

export interface Sidecar {
  app: SidecarApp;
  /** The composite every transport feeds; `on("log")` here sees every device's lines. */
  deviceServer: CompositeDeviceServer;
  /** The TCP/UDP member (for its resolved ports), or null when `"wifi"` isn't selected. */
  tcp: DeviceServer | null;
}

/** Stands in for the ESP-NOW transport when it isn't selected: there is nothing to route. */
const NO_ESPNOW: EspNowBridgePort = { setBridgeMac() {} };

export function createSidecar(inputs: SidecarInputs): Sidecar {
  const selected = new Set(inputs.transports ?? ALL_TRANSPORTS);
  if (selected.has("espnow") && !selected.has("usb")) {
    throw new Error('the "espnow" transport rides on USB; select "usb" too');
  }

  // The USB transport rides the same shell↔sidecar bridge `ipc` owns; the shell owns the port.
  // The ESP-NOW transport rides *on top of* USB: relayed lights reach the host through the
  // bridge's cable (see `docs/architecture.md`, "ESP-NOW transport").
  const usb = selected.has("usb") ? new UsbTransport(inputs.ipc) : null;
  const tcp = selected.has("wifi") ? new DeviceServer(inputs.tcp) : null;
  const espnow = usb && selected.has("espnow") ? new EspNowTransport(usb) : null;

  // Priority order — USB wins when a MAC is on more than one (a light cabled for
  // re-provisioning dedupes to its USB presence).
  const members: CompositeMember[] = [];
  if (usb) members.push({ transport: "usb", port: usb });
  if (tcp) members.push({ transport: "wifi", port: tcp });
  if (espnow) members.push({ transport: "espnow", port: espnow });
  const deviceServer = new CompositeDeviceServer(members, usb);

  const app = new SidecarApp({
    atem: inputs.atem,
    deviceServer,
    provisioning: deviceServer,
    espnow: espnow ?? NO_ESPNOW,
    store: inputs.store,
    ipc: inputs.ipc,
    log: inputs.log,
    scanNetwork: inputs.scanNetwork,
    dev: inputs.dev ?? false,
  });
  return { app, deviceServer, tcp };
}

export interface RunOptions {
  /** Called once the app has stopped (cleanly or not); the caller exits the process. */
  onExit: () => void;
  /** Where a failed shutdown is reported. */
  log: (message: string) => void;
}

/**
 * Stop the app on SIGINT, SIGTERM or stdin EOF, once, then hand over to `onExit`.
 *
 * The shell owns our stdin: EOF means it died or was killed without running its exit hook.
 * Exit too, or the orphan keeps TCP 7000 / UDP 7001 bound and the next launch can't start.
 */
export function runUntilClosed(app: Pick<SidecarApp, "stop">, options: RunOptions): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app
      .stop()
      .catch((err: unknown) => options.log(`shutdown error: ${(err as Error).message}`))
      .finally(options.onExit);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
}

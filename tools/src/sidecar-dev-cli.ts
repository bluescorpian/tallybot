/**
 * Hardware-free sidecar runner — the whole Phase 2 brain, driven by hand.
 *
 * It wires the real sidecar (orchestrator, engine, device server, ATEM adapter,
 * store, IPC) exactly as `app/sidecar/src/main.ts` does, but swaps the real `Atem`
 * for the Phase 1 `FakeAtem` and replaces the NDJSON-over-stdio UI with a terminal
 * REPL. So you can drive program/preview and assign devices here and watch the
 * colours land on `tally-client` simulators — the full `ATEM → sidecar → device`
 * data flow with nothing plugged in. This realises what `atem-sim-cli.ts` could only
 * preview in Phase 1.
 *
 *   pnpm sidecar-dev                     # listens on the real TCP 7000 / UDP 7001
 *   # then, in another terminal:
 *   pnpm tally-client -- --count 2       # two fake devices discover + connect
 *
 * It is a dev tool, not part of the shipped product — it binds the real ports so
 * actual simulators (or even real ESP32s on the LAN) can connect.
 */

import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { FakeAtem } from "./atem-sim.ts";

import { type IpcPort, SidecarApp } from "../../app/sidecar/src/app.ts";
import { AtemSource } from "../../app/sidecar/src/atem.ts";
import { DeviceServer } from "../../app/sidecar/src/device-server.ts";
import { ConfigStore } from "../../app/sidecar/src/store.ts";
import { type AppState, type SidecarEvent, type UiCommand } from "../../app/sidecar/src/ipc.ts";
import { type Color, COLORS, SETUP_COLOR } from "../../app/sidecar/src/protocol.ts";

// ── A REPL standing in for the UI's IPC channel ──────────────────────────────────

/** The IpcPort the UI normally fills, here backed by the terminal. */
class ReplIpc extends EventEmitter implements IpcPort {
  latest: AppState | undefined;
  send(event: SidecarEvent): void {
    if (event.type === "state") {
      this.latest = event.state;
      printBoard(event.state);
    } else if (event.type === "notice") {
      console.log(`${stamp()} ${event.level.toUpperCase()}: ${event.message}`);
    } else if (event.type === "sourceScan") {
      // The REPL has no scan UI; summarise progress/results inline.
      const hits = event.found.map((h) => h.ip).join(", ");
      console.log(`${stamp()} SCAN ${event.status}${hits ? `: ${hits}` : ""}`);
    } else {
      // USB device-log stream — handy for watching a WiFi-provisioning join over the cable.
      console.log(`${stamp()} LOG ${event.mac} ${event.level.toUpperCase()}: ${event.text}`);
    }
  }
  notice(level: "info" | "warn" | "error", message: string): void {
    console.log(`${stamp()} ${level.toUpperCase()}: ${message}`);
  }
  close(): void {}
  /** Push a command into the sidecar, as the UI would. */
  dispatch(command: UiCommand): void {
    this.emit("command", command);
  }
}

// ── Pretty printing ──────────────────────────────────────────────────────────────

const useColor = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];

function paint(text: string, color: Color): string {
  return useColor ? `\x1b[38;2;${color.r};${color.g};${color.b}m${text}\x1b[0m` : text;
}

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

const TALLY_COLOR = {
  live: COLORS.live,
  preview: COLORS.preview,
  idle: COLORS.idle,
  unknown: COLORS.disconnected, // fault: source untrustworthy, shown flashing-blue on the device
} as const;

function printBoard(state: AppState): void {
  const source = state.source;
  console.log(`\n${stamp()}  source: ATEM ${source.ip ?? "(no ip)"} — ${source.connection}`);
  for (const input of state.inputs) {
    const here = state.devices.filter((d) => d.inputId === input.id && d.state !== "offline");
    const tag = here.length ? `  ← ${here.map((d) => d.macTail).join(", ")}` : "";
    console.log(paint(`  input ${input.id}  ${input.label.padEnd(12)} ${input.tally.toUpperCase().padEnd(8)}`, TALLY_COLOR[input.tally]) + tag);
  }
  const unassigned = state.devices.filter((d) => d.state === "unassigned");
  const offline = state.devices.filter((d) => d.state === "offline");
  if (unassigned.length) {
    console.log(paint(`  dock (unassigned): ${unassigned.map((d) => d.macTail).join(", ")}`, SETUP_COLOR));
  }
  if (offline.length) console.log(`  offline: ${offline.map((d) => d.macTail).join(", ")}`);
  console.log();
}

// ── Resolve a device token (full MAC or tail) to a full MAC ──────────────────────

function resolveMac(state: AppState | undefined, token: string): string | null {
  if (!state) return null;
  const lower = token.toLowerCase();
  const match = state.devices.find((d) => d.mac === lower || d.mac.endsWith(lower) || d.macTail === lower);
  return match?.mac ?? null;
}

// ── REPL ───────────────────────────────────────────────────────────────────────

const USAGE = `commands:
  pgm <n>            put input n on program        (alias: p, program)
  pvw <n>            put input n on preview         (alias: v, preview)
  cut                swap program and preview
  name <id> <text>   rename an input
  assign <mac> <n>   assign a device to input n     (mac = full or tail)
  unassign <mac>     return a device to the dock
  flash <mac>        flash a device to locate it
  bright <mac> <n>   set a device's brightness (0–255)
  ls                 reprint the board
  ?                  this help
  q                  quit`;

async function main(): Promise<void> {
  const stateFile = process.env["TALLYBOT_STATE_FILE"] ?? join(tmpdir(), "tallybot-dev-state.json");
  const store = await ConfigStore.load(stateFile);
  const fakeAtem = new FakeAtem({ inputCount: 4, programInput: 1, previewInput: 2 });
  const atem = new AtemSource(fakeAtem);
  const server = new DeviceServer();
  const ipc = new ReplIpc();
  const app = new SidecarApp({ atem, deviceServer: server, store, ipc });

  await app.start();
  // Bring the fake ATEM online (its IP is irrelevant — the sim has no network).
  ipc.dispatch({ type: "setSource", ip: "simulated" });

  console.log(`tallybot sidecar (dev) — TCP ${server.tcpPort} / UDP ${server.discoveryPort}, state at ${stateFile}`);
  console.log(USAGE);

  const run = (action: () => void): void => {
    try {
      action();
    } catch (err) {
      console.error((err as Error).message);
    }
  };
  const macArg = (token: string | undefined): string => {
    const mac = resolveMac(ipc.latest, token ?? "");
    if (!mac) throw new Error(`no connected/known device matching "${token ?? ""}"`);
    return mac;
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "sidecar> " });
  rl.prompt();
  rl.on("line", (line) => {
    const [command, ...rest] = line.trim().split(/\s+/);
    switch ((command ?? "").toLowerCase()) {
      case "":
        break;
      case "p":
      case "pgm":
      case "program":
        run(() => void fakeAtem.changeProgramInput(Number(rest[0])));
        break;
      case "v":
      case "pvw":
      case "preview":
        run(() => void fakeAtem.changePreviewInput(Number(rest[0])));
        break;
      case "cut":
        run(() => void fakeAtem.cut());
        break;
      case "name":
        run(() => {
          const id = Number(rest[0]);
          const label = rest.slice(1).join(" ");
          if (!label) throw new Error("usage: name <id> <text>");
          fakeAtem.setInputName(id, label);
        });
        break;
      case "assign":
        run(() => ipc.dispatch({ type: "assignDevice", mac: macArg(rest[0]), inputId: Number(rest[1]) }));
        break;
      case "unassign":
        run(() => ipc.dispatch({ type: "unassignDevice", mac: macArg(rest[0]) }));
        break;
      case "flash":
      case "identify":
        run(() => ipc.dispatch({ type: "identifyDevice", mac: macArg(rest[0]) }));
        break;
      case "bright":
      case "brightness":
        run(() => ipc.dispatch({ type: "setBrightness", mac: macArg(rest[0]), brightness: Number(rest[1]) }));
        break;
      case "ls":
      case "board":
        if (ipc.latest) printBoard(ipc.latest);
        break;
      case "?":
      case "help":
        console.log(USAGE);
        break;
      case "q":
      case "quit":
      case "exit":
        rl.close();
        return;
      default:
        console.log(`unknown command "${command}" — try ? for help`);
    }
    rl.prompt();
  });
  rl.on("close", () => {
    void app.stop().finally(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  console.error(`fatal: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});

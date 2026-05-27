/**
 * Runnable ATEM simulator. Drives a {@link FakeAtem} from the terminal so you can
 * verify the full data flow — change program/preview here and watch the sidecar
 * push colours to devices.
 *
 *   node --experimental-strip-types src/atem-sim-cli.ts            # 4 inputs, pgm 1 / pvw 2
 *   node --experimental-strip-types src/atem-sim-cli.ts --inputs 6 --program 2
 *
 * Or via pnpm:  pnpm atem-sim -- --inputs 4
 *
 * Phase 1 has no sidecar to connect to yet; until Phase 2 this runner is a
 * self-contained way to exercise the stub and preview the tally each change
 * implies. The same FakeAtem is what the sidecar will consume in place of the real
 * `Atem` for hardware-free testing.
 */

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { type Color, COLORS } from "../../app/sidecar/src/protocol.ts";
import { type FakeAtemState, FakeAtem } from "./atem-sim.ts";

// ── Tally view ────────────────────────────────────────────────────────────────

const useColor = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];

function paint(text: string, color: Color): string {
  return useColor ? `\x1b[38;2;${color.r};${color.g};${color.b}m${text}\x1b[0m` : text;
}

/** What the sidecar's engine would derive: each input's tally from program/preview. */
function tallyOf(state: FakeAtemState, inputId: number): "live" | "preview" | "idle" {
  const me = state.video.mixEffects[0]!;
  if (inputId === me.programInput) return "live";
  if (inputId === me.previewInput) return "preview";
  return "idle";
}

function printState(state: FakeAtemState): void {
  const me = state.video.mixEffects[0]!;
  console.log(`\nprogram → ${me.programInput}   preview → ${me.previewInput}`);
  for (const input of Object.values(state.inputs)) {
    const tally = tallyOf(state, input.inputId);
    const dot = tally === "idle" ? "·" : "●";
    const label = `${tally.toUpperCase()}`.padEnd(8);
    const line = `  input ${input.inputId}  ${input.longName.padEnd(12)} ${dot} ${label}`;
    console.log(paint(line, COLORS[tally]));
  }
  console.log();
}

// ── Entry point ────────────────────────────────────────────────────────────────

const USAGE = `ATEM simulator — drive program/preview without a real switcher

Usage: node --experimental-strip-types src/atem-sim-cli.ts [options]

Options:
  --inputs <n>      number of camera inputs to seed (default: 4)
  --program <n>     initial program input (default: 1)
  --preview <n>     initial preview input (default: 2)
  -h, --help        show this help

Interactive commands:
  pgm <n>           put input n on program (alias: program, p)
  pvw <n>           put input n on preview (alias: preview, v)
  cut               take preview to air (program and preview swap)
  name <id> <text>  rename an input (the label tally inherits)
  ls                list inputs and the current tally
  quit              exit (alias: q)`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer, got "${value}"`);
  return n;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      inputs: { type: "string" },
      program: { type: "string" },
      preview: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const inputCount = positiveInt(values.inputs, "--inputs", 4);
  const programInput = positiveInt(values.program, "--program", 1);
  const previewInput = positiveInt(values.preview, "--preview", 2);
  if (programInput > inputCount || previewInput > inputCount) {
    fail(`--program/--preview must be within 1..${inputCount}`);
  }

  const atem = new FakeAtem({ inputCount, programInput, previewInput });

  atem.on("connected", () => {
    console.log(`connected to ${atem.state.info.model} — ${inputCount} inputs`);
    printState(atem.state);
  });
  atem.on("stateChanged", (state, paths) => {
    console.log(`stateChanged: ${paths.join(", ")}`);
    printState(state);
  });

  void atem.connect("simulated");

  // A control that maps a command to a FakeAtem call, surfacing any range error.
  const run = (action: () => void): void => {
    try {
      action();
    } catch (err) {
      console.error((err as Error).message);
    }
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "atem> " });
  rl.prompt();
  rl.on("line", (line) => {
    const [command, ...rest] = line.trim().split(/\s+/);
    switch ((command ?? "").toLowerCase()) {
      case "":
        break;
      case "p":
      case "pgm":
      case "program":
        run(() => void atem.changeProgramInput(Number(rest[0])));
        break;
      case "v":
      case "pvw":
      case "preview":
        run(() => void atem.changePreviewInput(Number(rest[0])));
        break;
      case "cut":
        run(() => void atem.cut());
        break;
      case "name":
        run(() => {
          const id = Number(rest[0]);
          const label = rest.slice(1).join(" ");
          if (!label) throw new Error("usage: name <id> <text>");
          atem.setInputName(id, label);
        });
        break;
      case "ls":
      case "inputs":
      case "state":
        printState(atem.state);
        break;
      case "q":
      case "quit":
      case "exit":
        rl.close();
        return;
      case "help":
      case "?":
        console.log(USAGE);
        break;
      default:
        console.log(`unknown command "${command}" — try: pgm, pvw, cut, name, ls, q`);
    }
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

main();

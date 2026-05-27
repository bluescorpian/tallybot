/**
 * Runnable tally client simulator. Wraps {@link TallyClient} with logging,
 * reconnection, optional multi-device spawning, and a small control REPL.
 *
 *   node --experimental-strip-types src/tally-client-cli.ts            # discover + connect
 *   node --experimental-strip-types src/tally-client-cli.ts --host 127.0.0.1
 *   node --experimental-strip-types src/tally-client-cli.ts --count 4  # four fake devices
 *
 * Or via pnpm:  pnpm tally-client -- --mac aa:bb:cc:dd:ee:ff --version 1
 */

import { once } from "node:events";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import {
  type Color,
  PROTOCOL_VERSION,
  SERVER_PORT,
  formatMac,
  macTail,
} from "../../app/sidecar/src/protocol.ts";
import { colorName, parseMac, randomMac } from "./device-protocol.ts";
import { DISCOVERY_INTERVAL_MS, TallyClient, discoverServer } from "./tally-client.ts";

// ── Pretty logging ────────────────────────────────────────────────────────────

const useColor = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];

/** A truecolor terminal swatch of the given colour, or "" when colour is off. */
function swatch(c: Color): string {
  return useColor ? `\x1b[48;2;${c.r};${c.g};${c.b}m   \x1b[0m` : "";
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8); // HH:MM:SS, local time
}

function log(mac: string, message: string): void {
  console.log(`${timestamp()} [${macTail(mac)}] ${message}`);
}

function describeSetColor(color: Color, brightness: number): string {
  const name = colorName(color);
  const label = (name ? name.toUpperCase() : "custom").padEnd(12);
  return `SET_COLOR  ${label} rgb(${color.r},${color.g},${color.b}) @${brightness} ${swatch(color)}`;
}

// ── One device: connect, log, and reconnect forever ─────────────────────────────

interface DeviceRunnerOptions {
  version: number;
  heartbeatIntervalMs?: number;
  /** Fixed server endpoint; when absent, the runner discovers one over UDP. */
  host?: string;
  port: number;
}

class DeviceRunner {
  readonly mac: string;
  readonly client: TallyClient;
  readonly #options: DeviceRunnerOptions;
  readonly #abort = new AbortController();
  #stopped = false;

  constructor(mac: string, options: DeviceRunnerOptions) {
    this.mac = mac;
    this.#options = options;
    this.client = new TallyClient({
      mac,
      version: options.version,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
    });
    this.client.on("connected", () => log(mac, `connected — sent HELLO v${options.version}`));
    this.client.on("setColor", (color, brightness) => log(mac, describeSetColor(color, brightness)));
    this.client.on("identify", () => log(mac, "IDENTIFY — flashing to locate"));
    this.client.on("error", (err) => log(mac, `socket error: ${err.message}`));
  }

  /** Discover/connect, then reconnect whenever the link drops, until stopped. */
  async run(): Promise<void> {
    while (!this.#stopped) {
      let target: { host: string; port: number };
      try {
        target = await this.#findServer();
      } catch (err) {
        if (this.#stopped) break;
        log(this.mac, `discovery failed: ${(err as Error).message} — retrying`);
        await this.#sleep(DISCOVERY_INTERVAL_MS);
        continue;
      }

      log(this.mac, `connecting to ${target.host}:${target.port}`);
      try {
        const disconnected = once(this.client, "disconnected", { signal: this.#abort.signal });
        this.client.connect(target.host, target.port);
        const [hadError] = (await disconnected) as [boolean];
        if (this.#stopped) break;
        log(this.mac, `disconnected${hadError ? " (with error)" : ""} — reconnecting`);
      } catch (err) {
        if (this.#stopped) break;
        log(this.mac, `connection error: ${(err as Error).message}`);
      }
      await this.#sleep(DISCOVERY_INTERVAL_MS);
    }
  }

  silence(): void {
    this.client.setHeartbeatsEnabled(false);
    log(this.mac, "heartbeats silenced — the server should time us out");
  }

  resume(): void {
    this.client.setHeartbeatsEnabled(true);
    log(this.mac, "heartbeats resumed");
  }

  /** Drop the connection; the run loop reconnects on its own. */
  reconnect(): void {
    log(this.mac, "dropping connection");
    this.client.close();
  }

  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
    this.client.close();
  }

  #findServer(): Promise<{ host: string; port: number }> {
    if (this.#options.host) {
      return Promise.resolve({ host: this.#options.host, port: this.#options.port });
    }
    log(this.mac, "discovering server (broadcasting TALLY_FIND)…");
    return discoverServer({ signal: this.#abort.signal });
  }

  /** Wait `ms`, or return early if the runner is stopped. */
  #sleep(ms: number): Promise<void> {
    const signal = this.#abort.signal;
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ── Identities ────────────────────────────────────────────────────────────────

/**
 * Build `count` device MACs. A single device uses the given MAC (or a random one);
 * several derive adjacent MACs from a base so they're easy to tell apart in the UI.
 */
function buildMacs(macArg: string | undefined, count: number): string[] {
  if (count === 1) return [macArg ?? randomMac()];
  const base = parseMac(macArg ?? randomMac());
  return Array.from({ length: count }, (_, i) => {
    const bytes = Uint8Array.from(base);
    bytes[5] = (bytes[5]! + i) & 0xff;
    return formatMac(bytes);
  });
}

// ── Control REPL (single device, interactive terminal) ──────────────────────────

function startRepl(runner: DeviceRunner): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
  console.log(
    "Commands: [s]ilence, [r]esume heartbeats · [d]rop to reconnect · [?]status · [q]uit",
  );
  rl.on("line", (line) => {
    switch (line.trim().toLowerCase()) {
      case "s":
      case "silence":
        runner.silence();
        break;
      case "r":
      case "resume":
        runner.resume();
        break;
      case "d":
      case "drop":
      case "reconnect":
        runner.reconnect();
        break;
      case "?":
      case "status":
        log(runner.mac, runner.client.connected ? "connected" : "not connected");
        break;
      case "q":
      case "quit":
      case "exit":
        rl.close();
        break;
      case "":
        break;
      default:
        console.log("unknown command — try: s, r, d, ?, q");
    }
  });
  rl.on("close", () => {
    runner.stop();
    process.exit(0);
  });
}

// ── Entry point ────────────────────────────────────────────────────────────────

const USAGE = `tally client simulator — a fake ESP32 tally device over TCP

Usage: node --experimental-strip-types src/tally-client-cli.ts [options]

Options:
  --mac <aa:bb:cc:dd:ee:ff>  device MAC (default: a random locally-administered one)
  --version <n>              protocol version to announce in HELLO (default: current)
  --host <ip>                connect directly, skipping UDP discovery
  --port <n>                 TCP port for --host (default: ${SERVER_PORT})
  --count <n>                spawn n devices with adjacent MACs (default: 1)
  --heartbeat <seconds>      heartbeat interval (default: 10)
  -h, --help                 show this help

With no --host, the device discovers the server by UDP broadcast. A single device
in an interactive terminal also gets a control REPL (silence/resume/drop/quit).`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      mac: { type: "string" },
      version: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      count: { type: "string", default: "1" },
      heartbeat: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1) fail(`--count must be a positive integer, got "${values.count}"`);

  const version = values.version === undefined ? undefined : Number(values.version);
  if (version !== undefined && (!Number.isInteger(version) || version < 0 || version > 255)) {
    fail(`--version must be a byte (0–255), got "${values.version}"`);
  }

  const port = values.port === undefined ? SERVER_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port must be 1–65535, got "${values.port}"`);

  const heartbeatIntervalMs =
    values.heartbeat === undefined ? undefined : Number(values.heartbeat) * 1000;
  if (heartbeatIntervalMs !== undefined && (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0)) {
    fail(`--heartbeat must be a positive number of seconds, got "${values.heartbeat}"`);
  }

  let macs: string[];
  try {
    macs = buildMacs(values.mac, count);
  } catch (err) {
    fail((err as Error).message);
  }

  const runnerOptions: DeviceRunnerOptions = {
    version: version ?? PROTOCOL_VERSION.CURRENT,
    heartbeatIntervalMs,
    host: values.host,
    port,
  };

  const mode = values.host ? `direct to ${values.host}:${port}` : "UDP discovery";
  console.log(
    `tally client: ${macs.length} device(s), protocol v${runnerOptions.version}, via ${mode}`,
  );

  const runners = macs.map((mac) => new DeviceRunner(mac, runnerOptions));
  for (const runner of runners) void runner.run();

  process.on("SIGINT", () => {
    for (const runner of runners) runner.stop();
    process.exit(0);
  });

  if (runners.length === 1 && process.stdin.isTTY) {
    startRepl(runners[0]!);
  }
}

main();

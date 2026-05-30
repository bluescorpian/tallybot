/**
 * TallyBot ATEM Probe — a standalone field-test tool.
 *
 * Goal: on a real ATEM (e.g. a Mini Pro), confirm the sidecar can connect and that
 * program/preview state updates actually arrive, with enough visibility to debug a
 * failure on site. It uses a vendored copy of the sidecar's real {@link AtemSource}
 * adapter (`src/atem-source.ts`, the same code production runs), so a green light here
 * means the production read-path works against this hardware — not a re-implementation
 * that might drift. The copy is what lets this folder ship on its own.
 *
 * Shape: a tiny HTTP server serves a single-page dashboard and streams live state +
 * logs to it over Server-Sent Events. Everything (UI included) is one process with no
 * runtime dependency beyond `atem-connection`. It's run straight from source with
 * Node (see run.cmd / run.sh), so the library's files live on disk in node_modules
 * exactly as it expects — no bundling, no native-module or worker workarounds.
 *
 * `disableMultithreaded: true` keeps `atem-connection`'s socket in this process rather
 * than a child worker, so every log line lands in the one console window — simpler to
 * watch and debug on site. It doesn't change what state we read.
 */

import { exec } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { Atem } from "atem-connection";

import { type AtemLike, AtemSource } from "./atem-source.ts";
import { PAGE } from "./ui.ts";

// ── Where the log + config live ──────────────────────────────────────────────────
// The working directory, which run.cmd / run.sh set to this tool's folder. The log is
// the "after the fact" troubleshooting artifact; the config just remembers the last IP.

const BASE_DIR = process.cwd();
const LOG_FILE = join(BASE_DIR, "tallybot-atem-probe.log");
const CONFIG_FILE = join(BASE_DIR, "tallybot-atem-probe.config.json");

const PREFERRED_PORT = 4848;

// ── Logging: console + rolling file + live SSE fan-out ───────────────────────────

type Level = "info" | "warn" | "error" | "debug";
interface LogLine {
  ts: number;
  level: Level;
  msg: string;
}

const recentLogs: LogLine[] = [];
const sseClients = new Set<ServerResponse>();

function log(level: Level, msg: string): void {
  const line: LogLine = { ts: Date.now(), level, msg };
  recentLogs.push(line);
  if (recentLogs.length > 2000) recentLogs.shift();

  const text = `${new Date(line.ts).toISOString()} [${level.toUpperCase()}] ${msg}`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${text}\n`);
  try {
    appendFileSync(LOG_FILE, `${text}\n`);
  } catch {
    /* a read-only CWD shouldn't take the tool down; the live console still works */
  }
  sse("log", line);
}

function sse(event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      /* dropped client; cleaned up on its 'close' */
    }
  }
}

// ── The ATEM, behind the production adapter ──────────────────────────────────────

const atem = new Atem({ disableMultithreaded: true });
const source = new AtemSource(atem as unknown as AtemLike);

/** Switcher model string ("ATEM Mini Pro"), learned once state arrives. */
let product: string | null = null;

interface ProbeState {
  ip: string | null;
  connection: string;
  programInput: number | null;
  previewInput: number | null;
  inputs: ReadonlyArray<{ id: number; label: string }>;
  product: string | null;
}

function currentState(): ProbeState {
  return { ...source.snapshot(), product };
}

// The normalised snapshot (what the sidecar's engine would consume) drives the UI.
source.on("change", () => sse("state", currentState()));
source.on("error", (err) => log("error", `source error: ${err.message}`));

// Raw library events give the "under the hood" detail the adapter abstracts away.
const rawAtem = atem as unknown as {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  state?: { info?: { productIdentifier?: string } };
};
rawAtem.on("connected", () => {
  product = rawAtem.state?.info?.productIdentifier ?? product;
  log("info", `ATEM connected${product ? ` — ${product}` : ""}`);
  sse("state", currentState());
});
rawAtem.on("disconnected", () => log("warn", "ATEM link dropped — library will try to reconnect"));
rawAtem.on("error", (err) => log("error", `atem error: ${(err as Error)?.message ?? String(err)}`));
rawAtem.on("stateChanged", (_state, paths) => {
  const changed = paths as string[];
  product = rawAtem.state?.info?.productIdentifier ?? product;
  const head = changed.slice(0, 6).join(", ");
  log("debug", `stateChanged: ${head}${changed.length > 6 ? ` …(+${changed.length - 6} more)` : ""}`);
});

// ── Config persistence ───────────────────────────────────────────────────────────

function loadConfig(): { lastIp?: string } {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { lastIp?: string };
  } catch {
    return {};
  }
}
function saveConfig(cfg: { lastIp?: string }): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch {
    /* best effort */
  }
}

// ── Connect / disconnect ─────────────────────────────────────────────────────────

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

async function connectTo(ip: string): Promise<void> {
  if (source.snapshot().ip) {
    await source.disconnect().catch(() => undefined);
  }
  saveConfig({ lastIp: ip });
  product = null;
  log("info", `connecting to ${ip} …`);
  source.connect(ip); // resolves async via the 'connected' event
}

// ── Discovery: best-effort subnet sweep ──────────────────────────────────────────
// There's no lightweight ATEM broadcast we can rely on, so we probe each host on the
// local /24 with the real handshake and keep the ones that actually complete it. It's
// the secondary path — manual entry above is the recommended one — so it's bounded and
// failures are swallowed rather than allowed to spam or stall.

function localSubnets(): { bases: Set<string>; selfIps: Set<string> } {
  const bases = new Set<string>();
  const selfIps = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) {
        bases.add(ni.address.split(".").slice(0, 3).join("."));
        selfIps.add(ni.address);
      }
    }
  }
  return { bases, selfIps };
}

function probe(ip: string, timeoutMs: number): Promise<{ ip: string; product: string | null } | null> {
  return new Promise((resolve) => {
    const candidate = new Atem({ disableMultithreaded: true }) as unknown as {
      on(e: string, l: (...a: unknown[]) => void): unknown;
      removeAllListeners?: () => void;
      connect(ip: string): Promise<void>;
      destroy?: () => Promise<void>;
      state?: { info?: { productIdentifier?: string } };
    };
    let settled = false;
    const finish = (result: { ip: string; product: string | null } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      candidate.removeAllListeners?.();
      Promise.resolve(candidate.destroy?.()).catch(() => undefined);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    candidate.on("error", () => undefined); // unreachable hosts are expected; stay quiet
    candidate.on("connected", () => finish({ ip, product: candidate.state?.info?.productIdentifier ?? null }));
    Promise.resolve(candidate.connect(ip)).catch(() => finish(null));
  });
}

async function scanNetwork(): Promise<Array<{ ip: string; product: string | null }>> {
  const { bases, selfIps } = localSubnets();
  const candidates: string[] = [];
  for (const base of bases) {
    for (let host = 1; host <= 254; host++) {
      const ip = `${base}.${host}`;
      if (!selfIps.has(ip)) candidates.push(ip);
    }
  }
  if (!candidates.length) {
    log("warn", "no non-internal IPv4 interface found to scan");
    return [];
  }
  log("info", `scanning ${candidates.length} address(es) across ${bases.size} subnet(s) for ATEMs …`);

  const found: Array<{ ip: string; product: string | null }> = [];
  const CONCURRENCY = 24;
  const TIMEOUT_MS = 1500;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const ip = candidates[next++]!;
      const hit = await probe(ip, TIMEOUT_MS);
      if (hit) {
        found.push(hit);
        log("info", `found ATEM at ${hit.ip}${hit.product ? ` — ${hit.product}` : ""}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  log("info", `scan complete — ${found.length} switcher(s) found`);
  return found;
}

// ── HTTP server ──────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }

    if (method === "GET" && url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":ok\n\n");
      sseClients.add(res);
      // Replay current state + recent history so a fresh tab is immediately useful.
      res.write(`event: state\ndata: ${JSON.stringify(currentState())}\n\n`);
      for (const line of recentLogs.slice(-300)) {
        res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
      }
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (method === "GET" && url === "/config") {
      json(res, 200, loadConfig());
      return;
    }

    if (method === "GET" && url === "/log") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": "attachment; filename=tallybot-atem-probe.log",
      });
      try {
        res.end(readFileSync(LOG_FILE));
      } catch {
        res.end(recentLogs.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.msg}`).join("\n"));
      }
      return;
    }

    if (method === "POST" && url === "/connect") {
      let ip = "";
      try {
        ip = String((JSON.parse(await readBody(req)) as { ip?: string }).ip ?? "").trim();
      } catch {
        /* falls through to validation below */
      }
      if (!IPV4.test(ip) || ip.split(".").some((o) => Number(o) > 255)) {
        json(res, 400, { error: "expected a valid IPv4 address" });
        return;
      }
      await connectTo(ip);
      json(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url === "/disconnect") {
      await source.disconnect().catch(() => undefined);
      product = null;
      log("info", "disconnected by user");
      json(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url === "/scan") {
      const found = await scanNetwork();
      json(res, 200, { found });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    log("error", `request ${method} ${url} failed: ${(err as Error).message}`);
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
  }
});

// ── Startup: bind a port (retrying past collisions) and open the browser ─────────

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "win32"
      ? `cmd /c start "" "${url}"`
      : platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => undefined); // failure is fine — the URL is printed for manual use
}

function start(port: number, attemptsLeft: number): void {
  const onError = (err: NodeJS.ErrnoException): void => {
    server.removeListener("listening", onListening);
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      start(port + 1, attemptsLeft - 1);
    } else {
      log("error", `could not start server: ${err.message}`);
      process.exit(1);
    }
  };
  const onListening = (): void => {
    server.removeListener("error", onError);
    const url = `http://127.0.0.1:${port}/`;
    process.stdout.write(`\n  TallyBot ATEM Probe is running.\n  Open ${url} in your browser.\n  Log file: ${LOG_FILE}\n\n`);
    log("info", `probe ready on ${url}`);
    openBrowser(url);
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, "127.0.0.1");
}

const shutdown = (): void => {
  log("info", "shutting down");
  void source.disconnect().catch(() => undefined).finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Build-time smoke test: prove the bundle loads and everything above constructs/wires
// without errors, then exit — no port bound, no browser opened. See build.sh.
if (process.env["PROBE_SELFTEST"]) {
  process.stdout.write("selftest: module loaded and ATEM adapter wired ok\n");
  process.exit(0);
}

log("info", `TallyBot ATEM Probe starting (pid ${process.pid})`);
start(PREFERRED_PORT, 20);

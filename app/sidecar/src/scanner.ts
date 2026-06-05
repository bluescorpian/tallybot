/**
 * ATEM discovery — a best-effort local-subnet sweep for the settings "Scan".
 *
 * There's no lightweight ATEM broadcast we can rely on, so we probe each host on the
 * local /24(s) with the real `atem-connection` handshake and keep the ones that
 * actually complete it. It's the *secondary* path — typing the IP by hand is the
 * recommended one — so it's bounded (capped concurrency, short per-host timeout) and
 * unreachable hosts fail quietly rather than spamming or stalling.
 *
 * This is the same logic field-proven in `tools/atem-probe` (it found a real Mini Pro
 * in ~16s across a /24); it lives here so the production sidecar can run it directly.
 * Each probe uses `disableMultithreaded: true` so the candidate sockets stay in this
 * process instead of spawning a worker thread per host.
 */

import { networkInterfaces } from "node:os";

import { Atem } from "atem-connection";

import type { SourceScanHit } from "./ipc.ts";

/** Run up to this many candidate handshakes at once. */
const CONCURRENCY = 24;
/** Give each candidate this long to complete the handshake before giving up. */
const TIMEOUT_MS = 1500;

/** The /24 bases of every non-internal IPv4 interface, plus our own addresses. */
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

/** Attempt the ATEM handshake against one host; resolve a hit or null (never throws). */
function probe(ip: string, timeoutMs: number): Promise<SourceScanHit | null> {
  return new Promise((resolve) => {
    const candidate = new Atem({ disableMultithreaded: true }) as unknown as {
      on(e: string, l: (...a: unknown[]) => void): unknown;
      removeAllListeners?: () => void;
      connect(ip: string): Promise<void>;
      destroy?: () => Promise<void>;
      state?: { info?: { productIdentifier?: string } };
    };
    let settled = false;
    const finish = (result: SourceScanHit | null): void => {
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

/**
 * Sweep every host on the local subnet(s) and return the ATEMs that answered, sorted
 * numerically by IP. `log` (defaults to stderr) traces progress for troubleshooting;
 * it never writes to stdout, which is reserved for the NDJSON protocol.
 */
export async function scanNetwork(
  log: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): Promise<SourceScanHit[]> {
  const { bases, selfIps } = localSubnets();
  const candidates: string[] = [];
  for (const base of bases) {
    for (let host = 1; host <= 254; host++) {
      const ip = `${base}.${host}`;
      if (!selfIps.has(ip)) candidates.push(ip);
    }
  }
  if (!candidates.length) {
    log("scan: no non-internal IPv4 interface found to scan");
    return [];
  }
  log(`scan: probing ${candidates.length} address(es) across ${bases.size} subnet(s) …`);

  const found: SourceScanHit[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const ip = candidates[next++]!;
      const hit = await probe(ip, TIMEOUT_MS);
      if (hit) {
        found.push(hit);
        log(`scan: found ATEM at ${hit.ip}${hit.product ? ` — ${hit.product}` : ""}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  log(`scan: complete — ${found.length} switcher(s) found`);
  return found;
}

/**
 * The fault book: the sidecar's live {@link Fault}s, keyed by condition.
 *
 * One place decides what the operator is told about a failure the sidecar sees. A raise always
 * writes a log line (with the underlying cause, which the operator-facing message may leave out);
 * the fault then rides every `AppState` snapshot until its condition clears. Raising the same key
 * again replaces the entry, so a repeating error is one fault, not a growing list.
 *
 * The book only records; the orchestrator (`app.ts`) owns when to clear each key and publishes a
 * fresh snapshot whenever {@link FaultBook.raise} or {@link FaultBook.clear} reports a change.
 */

import type { Fault } from "./ipc.ts";

export interface FaultReport extends Omit<Fault, "mac"> {
  mac?: string | null;
  /** The underlying error, for the log only. */
  cause?: unknown;
}

/** A thrown value as one log-worthy line: an Error's message, anything else stringified. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class FaultBook {
  readonly #faults = new Map<string, Fault>();
  readonly #log: (message: string) => void;

  constructor(log: (message: string) => void) {
    this.#log = log;
  }

  /** Record (or replace) a fault and log it. Returns true when the visible fault changed. */
  raise(report: FaultReport): boolean {
    const fault: Fault = { key: report.key, level: report.level, message: report.message, mac: report.mac ?? null };
    const cause = report.cause === undefined ? "" : ` (${describeError(report.cause)})`;
    this.#log(`fault ${fault.key} [${fault.level}]: ${fault.message}${cause}`);
    const previous = this.#faults.get(fault.key);
    if (previous && previous.level === fault.level && previous.message === fault.message && previous.mac === fault.mac) {
      return false;
    }
    // Re-insert so a changed fault moves to the end: the list stays oldest-first by last change.
    this.#faults.delete(fault.key);
    this.#faults.set(fault.key, fault);
    return true;
  }

  /** Drop a fault whose condition cleared. Returns true when there was one. */
  clear(key: string): boolean {
    const had = this.#faults.delete(key);
    if (had) this.#log(`fault ${key} cleared`);
    return had;
  }

  list(): Fault[] {
    return [...this.#faults.values()];
  }
}

/**
 * A size-bounded, rotating diagnostic log file.
 *
 * The packaged Windows sidecar has no console, so its stderr is invisible after a show; this
 * file is what gets opened (or sent) to explain a fault. It must never hurt the show it records:
 * {@link RotatingLogFile.write} is synchronous and infallible — it timestamps the line and queues
 * it — while a single async drain appends queued lines in batches. Any filesystem error drops the
 * batch and the next write retries from scratch, so a full or failing disk costs lines, never
 * tally. The queue itself is capped, so a disk that stalls can't grow memory without bound.
 *
 * Rotation is `name` → `name.1` → … → `name.<keep>`, checked before each append; the oldest is
 * overwritten by the rename. Total disk use is about `maxBytes × (keep + 1)` at most, barring a
 * live file that can't be renamed (see `#rotate`).
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface RotatingLogFileOptions {
  /** Rotate once the live file would grow past this many bytes. */
  maxBytes: number;
  /** How many rotated files (`.1` … `.<keep>`) to retain beside the live one. */
  keep: number;
  /** Queued-but-unwritten bytes beyond which new lines are dropped (a stalled disk). */
  maxPendingBytes?: number;
}

export class RotatingLogFile {
  readonly path: string;
  readonly #maxBytes: number;
  readonly #keep: number;
  readonly #maxPendingBytes: number;

  #pending: string[] = [];
  #pendingBytes = 0;
  #dropped = 0;
  /** Current size of the live file; `undefined` until (re)learned from disk. */
  #size: number | undefined;
  #drain: Promise<void> | undefined;

  constructor(path: string, options: RotatingLogFileOptions) {
    this.path = path;
    this.#maxBytes = options.maxBytes;
    this.#keep = options.keep;
    this.#maxPendingBytes = options.maxPendingBytes ?? 1024 * 1024;
  }

  /** Queue one line (a trailing newline is added). Never throws, never blocks. */
  write(line: string): void {
    const entry = `${timestamp(new Date())} ${line.trimEnd()}\n`;
    const bytes = Buffer.byteLength(entry);
    if (this.#pendingBytes + bytes > this.#maxPendingBytes) {
      this.#dropped++;
      return;
    }
    this.#pending.push(entry);
    this.#pendingBytes += bytes;
    this.#drain ??= this.#run().finally(() => (this.#drain = undefined));
  }

  /** Resolves once everything queued so far has been written (or dropped). Never rejects. */
  async flush(): Promise<void> {
    while (this.#drain) await this.#drain;
  }

  async #run(): Promise<void> {
    while (this.#pending.length > 0) {
      if (this.#dropped > 0) {
        const note = `${timestamp(new Date())} [log] ${this.#dropped} line(s) dropped: write queue full\n`;
        this.#pending.unshift(note);
        this.#pendingBytes += Buffer.byteLength(note);
        this.#dropped = 0;
      }
      const chunk = this.#pending.join("");
      const bytes = this.#pendingBytes;
      this.#pending = [];
      this.#pendingBytes = 0;
      try {
        if (this.#size === undefined) {
          await mkdir(dirname(this.path), { recursive: true });
          this.#size = await stat(this.path).then(
            (s) => s.size,
            () => 0,
          );
        }
        if (this.#size > 0 && this.#size + bytes > this.#maxBytes && (await this.#rotate())) {
          this.#size = 0;
        }
        await appendFile(this.path, chunk);
        this.#size += bytes;
      } catch {
        // Drop the batch; relearn the file's state on the next one.
        this.#size = undefined;
      }
    }
  }

  /**
   * Shift the files along, oldest-first so no rename lands on one still to be moved; a missing
   * `.n` is normal (fewer rotations so far). Returns whether the live file moved. If it couldn't
   * (on Windows, another program holding it open without delete-sharing), the caller keeps
   * appending past the cap and retries next batch: losing the show's log is worse than a
   * temporarily oversized file.
   */
  async #rotate(): Promise<boolean> {
    for (let n = this.#keep - 1; n >= 1; n--) {
      await rename(`${this.path}.${n}`, `${this.path}.${n + 1}`).catch(() => {});
    }
    return rename(this.path, `${this.path}.1`).then(
      () => true,
      () => false,
    );
  }
}

/** Local wall-clock time with its UTC offset, e.g. `2026-10-26 19:33:21.042+02:00`. */
function timestamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

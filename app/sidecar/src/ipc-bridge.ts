/**
 * The IPC bridge — the sidecar's end of the NDJSON-over-stdio contract with the UI
 * (`src/ipc.ts`; rationale in `SIDECAR.md`).
 *
 * Commands arrive as one JSON object per line on stdin; state and notices go out as
 * one JSON object per line on stdout. stdout therefore carries *protocol only* —
 * diagnostics must go to stderr or they corrupt the stream. The Tauri shell (Phase
 * 5) pumps these lines between the child process and the webview; nothing here cares
 * who is on the other end, so a test can drive it with a plain pair of streams.
 */

import { EventEmitter } from "node:events";
import { type Interface, createInterface } from "node:readline";

import { type SidecarEvent, type UiCommand, parseCommand, serializeMessage } from "./ipc.ts";

export interface IpcBridgeOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

// Typed events (the interface merges with the class and is erased at build).
export interface IpcBridge {
  on(event: "command", listener: (command: UiCommand) => void): this;
  emit(event: "command", command: UiCommand): boolean;
}

export class IpcBridge extends EventEmitter {
  readonly #output: NodeJS.WritableStream;
  readonly #readline: Interface;

  constructor(options: IpcBridgeOptions = {}) {
    super();
    const input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#readline = createInterface({ input, crlfDelay: Infinity });
    this.#readline.on("line", (line) => {
      if (line.trim() === "") return;
      const command = parseCommand(line);
      // Unrecognised lines are dropped: this is a trusted local pipe, and ipc.ts
      // validates only the discriminant (see parseCommand).
      if (command) this.emit("command", command);
    });
  }

  /** Emit one event to the UI. */
  send(event: SidecarEvent): void {
    this.#output.write(serializeMessage(event));
  }

  /** Convenience for an out-of-band notice (info / warn / error). */
  notice(level: "info" | "warn" | "error", message: string): void {
    this.send({ type: "notice", level, message });
  }

  /** Stop reading stdin (shutdown). */
  close(): void {
    this.#readline.close();
  }
}

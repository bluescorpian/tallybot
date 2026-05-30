/**
 * ATEM integration — turns the switcher's state into the probe's input.
 *
 * ── VENDORED ──────────────────────────────────────────────────────────────────────
 * This is a self-contained copy of the sidecar's adapter (`app/sidecar/src/atem.ts`),
 * so this probe can be zipped up and run on its own without the rest of the repo. The
 * logic below is verbatim; only the two cross-module *type* imports it relied on
 * (`SourceSnapshot`, `SourceConnection`) are inlined here. If the sidecar's adapter
 * changes in a way that matters for hardware testing, re-copy it.
 * ──────────────────────────────────────────────────────────────────────────────────
 *
 * The sidecar reads only a thin slice of the `atem-connection` library: connect /
 * disconnect, the connection lifecycle events, and the program/preview inputs plus
 * input names off mix-effect 0. {@link AtemLike} captures exactly that slice, so
 * `AtemSource` depends on the seam, not the library.
 *
 * `AtemSource` normalises the library's evolving state into the flat
 * {@link SourceSnapshot} consumers read, and emits `change` whenever that snapshot
 * moves. The last-known inputs are *retained* across a disconnect so the UI keeps the
 * rig's layout while flagging the source offline.
 */

import { EventEmitter } from "node:events";

// ── Inlined from the sidecar (ipc.ts / engine.ts) ────────────────────────────────

/** Whether we currently have a trustworthy link to the source. */
export type SourceConnection = "connected" | "connecting" | "disconnected";

/** The current normalised view of the source (what the sidecar's engine consumes). */
export interface SourceSnapshot {
  /** The configured ATEM IP, or null until the user sets one. */
  ip: string | null;
  connection: SourceConnection;
  /** Input on program output, or null when unknown (e.g. not connected). */
  programInput: number | null;
  /** Input on preview, or null when unknown. */
  previewInput: number | null;
  /** The source's camera inputs and their labels, in display order. */
  inputs: ReadonlyArray<{ id: number; label: string }>;
}

// ── The slice of `atem-connection` the sidecar uses ──────────────────────────────
// Loose/optional throughout so both the real Atem (state undefined until connected,
// sparse arrays) and a FakeAtem stand-in satisfy it structurally.

export interface AtemInputChannel {
  longName?: string;
  shortName?: string;
}
export interface AtemMixEffect {
  programInput?: number;
  previewInput?: number;
}
export interface AtemStateSlice {
  video?: { mixEffects?: ReadonlyArray<AtemMixEffect | undefined> };
  inputs?: Record<number, AtemInputChannel | undefined>;
}

export interface AtemLike {
  readonly state: AtemStateSlice | undefined;
  connect(address: string, port?: number): Promise<void>;
  disconnect(): Promise<void>;
  on(event: "connected", listener: () => void): unknown;
  on(event: "disconnected", listener: () => void): unknown;
  on(event: "stateChanged", listener: (state: AtemStateSlice, pathsChanged: string[]) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface AtemSourceOptions {
  /**
   * Which `state.inputs` entries count as tally-able camera inputs. The default
   * keeps the external range (id 1–999), excluding black (0) and the ATEM's
   * internal sources (colour bars, media players, ME outputs — all id ≥ 1000).
   */
  inputFilter?: (id: number) => boolean;
}

const DEFAULT_INPUT_FILTER = (id: number): boolean => id >= 1 && id < 1000;

// Typed events (the interface merges with the class and is erased at build).
export interface AtemSource {
  on(event: "change", listener: (snapshot: SourceSnapshot) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  emit(event: "change", snapshot: SourceSnapshot): boolean;
  emit(event: "error", err: Error): boolean;
}

export class AtemSource extends EventEmitter {
  readonly #atem: AtemLike;
  readonly #inputFilter: (id: number) => boolean;

  #ip: string | null = null;
  #connection: SourceConnection = "disconnected";
  /** True between connect() and disconnect(): a drop then means "reconnecting". */
  #wantConnection = false;

  // Last-known scene, retained across a disconnect so the board keeps its layout.
  #programInput: number | null = null;
  #previewInput: number | null = null;
  #inputs: Array<{ id: number; label: string }> = [];

  constructor(atem: AtemLike, options: AtemSourceOptions = {}) {
    super();
    this.#atem = atem;
    this.#inputFilter = options.inputFilter ?? DEFAULT_INPUT_FILTER;

    atem.on("connected", () => {
      this.#connection = "connected";
      this.#refresh();
      this.emit("change", this.snapshot());
    });
    atem.on("disconnected", () => {
      // The library reconnects on its own; reflect "connecting" while we still want it.
      this.#connection = this.#wantConnection ? "connecting" : "disconnected";
      this.emit("change", this.snapshot());
    });
    atem.on("stateChanged", () => {
      this.#refresh();
      this.emit("change", this.snapshot());
    });
    atem.on("error", (err) => this.emit("error", err));
  }

  /** The current normalised view of the source. */
  snapshot(): SourceSnapshot {
    return {
      ip: this.#ip,
      connection: this.#connection,
      programInput: this.#programInput,
      previewInput: this.#previewInput,
      inputs: this.#inputs,
    };
  }

  /**
   * Connect to the ATEM at `ip` (or reconnect to a new one). Connection completes
   * asynchronously via the library's `connected` event; this just starts it.
   */
  connect(ip: string): void {
    this.#ip = ip;
    this.#wantConnection = true;
    this.#connection = "connecting";
    this.emit("change", this.snapshot());
    void this.#atem.connect(ip).catch((err: unknown) => this.emit("error", err as Error));
  }

  /** Stop talking to the ATEM. The retained inputs stay so the board keeps its shape. */
  async disconnect(): Promise<void> {
    this.#wantConnection = false;
    this.#connection = "disconnected";
    try {
      await this.#atem.disconnect();
    } catch (err) {
      this.emit("error", err as Error);
    }
    this.emit("change", this.snapshot());
  }

  /** Pull program/preview and input labels out of the library's current state. */
  #refresh(): void {
    const state = this.#atem.state;
    const me = state?.video?.mixEffects?.[0];
    this.#programInput = me?.programInput ?? null;
    this.#previewInput = me?.previewInput ?? null;

    const inputs = state?.inputs;
    if (inputs) {
      const list: Array<{ id: number; label: string }> = [];
      for (const [key, channel] of Object.entries(inputs)) {
        const id = Number(key);
        if (!Number.isInteger(id) || !this.#inputFilter(id)) continue;
        const label = channel?.longName?.trim() || channel?.shortName?.trim() || `Input ${id}`;
        list.push({ id, label });
      }
      list.sort((a, b) => a.id - b.id); // left-to-right, like the switcher's button strip
      this.#inputs = list;
    }
  }
}

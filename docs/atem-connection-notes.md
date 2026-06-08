# Working with `atem-connection` — Sharp Edges & Good-to-Knows

Practical notes on the `atem-connection` library: the non-obvious behaviours, gotchas, and
best practices we've hit (or want to avoid hitting) in the sidecar. Reverse-engineered by
reading the source of
[`Sofie-Automation/sofie-atem-connection`](https://github.com/Sofie-Automation/sofie-atem-connection)
(`atem-connection` v3.9.0) and its `threadedclass` v1.4.0 dependency; clones live under
`.exploration/` (gitignored). File:line citations point into those repos.

Build-time / packaging sharp edges (loading `atemSocketChild` by path, the native
`@julusian/freetype2` dep, single-binary caveats) live in `ARCHITECTURE.md` →
*Packaging the Sidecar*. This doc covers **runtime** behaviour.

Contents:
1. [Threading model (multithreaded by default)](#1-threading-model-multithreaded-by-default) — and the open decision about disabling it
2. [Lifecycle & avoiding memory leaks](#2-lifecycle--avoiding-memory-leaks)
3. [The library logs to stdout](#3-the-library-logs-to-stdout)
4. [Transition tally: both sources are live during a mix](#4-transition-tally-both-sources-are-live-during-a-mix) — field-confirmed, needs engine change
5. [Program/preview can be a non-camera source](#5-programpreview-can-be-a-non-camera-source) — black, stills, media players; an invariant to preserve

---

## 1. Threading model (multithreaded by default)

By default `new Atem()` runs its UDP socket **off the main thread**. Only one class crosses
that boundary — `AtemSocketChild` (`src/lib/atemSocketChild.ts`) — and it *is* the
reverse-engineered ATEM transport:

- the `dgram` UDP socket itself,
- the `COMMAND_CONNECT_HELLO` handshake and session-id negotiation,
- packet-id sequencing, ACK batching, and the retransmit / in-flight-tracking machinery,
- the keepalive + reconnect loop.

Everything *above* the socket — command parsing, state mutation, and the `stateChanged`
event the sidecar actually consumes — stays on the main thread. The split is done by the
`threadedclass` library: `AtemSocket` (`src/lib/atemSocket.ts:131`, the main-thread half)
spawns the child via `threadedClass(...)` and proxies every method call across the boundary
as an async message. So the threaded part is small and specific: the latency-sensitive
socket loop, nothing else.

### Why the library isolates the socket

The ATEM protocol is **soft-real-time**. The child's own timing constants
(`atemSocketChild.ts:7-13`) make this concrete:

```
RETRANSMIT_INTERVAL   = 10 ms     // resend-check cadence
IN_FLIGHT_TIMEOUT     = 60 ms     // un-acked packet → resend
_sendOrQueueAck       =  5 ms     // ack coalescing window
CONNECTION_TIMEOUT  = 5000 ms     // no traffic → tear down & reconnect
```

The ATEM drops the session if ACKs arrive late. `atem-connection` is built for **Sofie
Automation**, a broadcast-automation system whose main process can be heavily loaded (GC
pauses, large synchronous work); running the socket in its own thread insulates that timing
from whatever the host is doing on its main loop. The `threadedclass` wrapper adds a second
benefit — a **freeze watchdog**: the socket is spawned with `autoRestart: true` and pinged
every 600 ms (`atemSocket.ts:157-162`), and is killed/respawned if it stops responding
(after which `AtemSocket` re-runs `connect()`). The socket can wedge or throw without taking
the host process down.

The maintainer puts a **concrete number** on the risk of running on the shared loop: *any
synchronous operation over ~20 ms is likely to drop the connection* — "even things as
simple as parsing a chunk of json, or just while loops that dont yield" ([#106]). The
resend timeout is 60 ms ([#136]). Whether single-threaded is safe is therefore entirely
**load-dependent** — there's no universal safe answer; it depends on the machine and how
busy the loop gets ([#136]).

On Node it's a `worker_threads` worker, falling back to a forked child process only on very
old Node (`manager.ts:869-873`). Either transport loads `atemSocketChild` **by file path at
runtime** — the root cause of packaging warning #1 (and of the recurring bundler failures
in [#106]/[#133]/[#125]; see [Upstream issues](#upstream-issues--field-reports)).

### What `disableMultithreaded: true` actually does

The flag (`AtemOptions.disableMultithreaded`, `atem.ts:76`; default `false`, i.e.
multithreading **on**) swaps the real worker for an in-process stub: `threadedclass`
constructs `AtemSocketChild` in the **same event loop and memory**, arguments passed by
reference (`EncodingStrategy.InProcess`). The **public API is byte-for-byte identical** and
**the ATEM state we read does not change in any way.** It's a first-class, supported mode —
it's the documented fallback when the host can't spawn a worker (e.g. a browser without Web
Worker support), and the library's own dev notes reach for it.

### What changes, precisely

| | Multithreaded (default) | `disableMultithreaded: true` |
|---|---|---|
| ATEM state read / public API | identical | identical |
| Socket runs on | its own `worker_threads` thread | the host's main event loop |
| Event-loop isolation | **yes** | **no** |
| Freeze watchdog / auto-restart | **active** | effectively **moot** (shares the loop) |
| Reconnect-to-ATEM logic | active | **still active** (runs in-process) |
| Packaging | needs `atemSocketChild` on disk + worker spawn | single process, no spawn |

- **Lost — event-loop isolation.** If anything blocks the sidecar's loop for a few hundred
  ms (heavy sync work, a GC pause), ACKs/retransmits are delayed and the ATEM may drop the
  session.
- **Lost — the freeze watchdog is moot.** Its ping runs on the *same* loop as the socket, so
  a synchronous freeze freezes the watchdog too. A throw in the socket now surfaces in the
  host process instead of an isolated, restartable child.
- **Kept — reconnection to the ATEM.** `AtemSocketChild`'s own reconnect logic (1 s retry,
  5 s no-traffic timeout, `restartConnection()` on socket error / packet timeout) runs
  in-process and is unaffected. Resilience to *the ATEM dropping* is unchanged; only the
  "the socket code itself wedged" net is lost.
- **Gained — packaging & observability.** No worker spawn and no runtime path-`require` of
  `atemSocketChild`; one process, one console; one fewer `stdout` writer (see §3).

### Open decision

Multithreaded is the library's **default and recommended** configuration, so turning it off
trades operational resilience (under main-loop contention) for packaging simplicity — a
trade to make on purpose, not inherit by accident.

**For disabling, specific to TallyBot:** the sidecar's loop only does light, I/O-bound work
(small state diffs in, tiny TCP commands out to a few ESP32s, UDP discovery), so the
isolation buys little *here*; `tools/atem-probe` already runs single-threaded
(`tools/atem-probe/src/main.ts:83`) and reads state correctly on real hardware; packaging is
materially simpler single-threaded.

**Against:** it's off the beaten path, and we'd give up a safety net for a failure mode that
*can* happen if the sidecar's loop ever grows heavier.

**Resolve before deciding:** (a) will the sidecar's main loop ever do meaningful synchronous
work? The upstream threshold is **~20 ms** ([#106]); our loop is light I/O and comfortably
under it, but watch any large synchronous JSON/state handling. (b) can we keep the default
*and* still package cleanly — i.e. solve warning #1 by shipping `atemSocketChild` on disk
rather than reaching for the flag? Our sidecar already ships as a Node process with files on
disk (like `tools/atem-probe`), which **sidesteps the bundler failures entirely** — those
only bite when the library is collapsed into one bundle/binary. (c) if we disable, is
`AtemSocketChild`'s own reconnect loop enough to replace the watchdog?

Production (`app/sidecar/`) still uses the default `new Atem()`. Decide consciously in Phase 5.

---

## 2. Lifecycle & avoiding memory leaks

`atem-connection` cleans up after itself **only if you tell it to**. An `Atem` instance owns
a worker thread (or, single-threaded, a set of in-process timers), a UDP socket, several
timers, and a couple of process exit-hooks. Repeated create/destroy is leak-free *if* you
follow these rules:

1. **Always `await atem.destroy()`** when you're done with an instance. That's what releases
   the worker thread, the dgram socket, the reconnect/retransmit/ack timers, the
   data-transfer interval, and the library's exit-hooks. Letting an `Atem` fall out of scope
   *without* `destroy()` leaks all of that, and it accumulates per abandoned instance — this
   is the real leak path.
2. **Drop your reference afterwards**, and if you keep one, call `atem.removeAllListeners()`.
   `destroy()` cleans the library's internals but **not** the listeners *you* attached
   (`atem.on('stateChanged', …)`); those keep the instance — and their closures — alive.
3. **`destroy()` is async** — it resolves after the worker has actually closed. If you
   rapidly recreate (e.g. rebuild the connection on an IP change), `await` each `destroy()`
   before the next `new Atem()` so teardown and setup don't interleave.
4. **Recreating is fine** — no per-instance global state accumulates in the library. But in
   *multithreaded* mode each cycle spawns and terminates a real OS thread; if your design
   recreates often, that churn is one more nudge toward `disableMultithreaded` (same
   leak-safety, no thread spawn).

Good-to-know: a clean `destroy()` emits a final `disconnected` event during teardown — don't
treat a `disconnected` received while shutting down as a fault.

On a **hard parent crash** (not a graceful exit), the multithreaded child could historically
be orphaned ([#68]) — back when it was a forked child process. The `worker_threads` rewrite
mitigates this (a worker thread dies with its parent; a forked process does not), and the
single-threaded mode can't orphan anything at all. The exit-hooks above are the *graceful*
backstop; worker-dies-with-parent is the *crash* backstop.

Done this way, create/destroy is verified leak-free: the worker is terminated, every timer
cleared, the `threadedclass` registry entry and its event listeners removed, and the
auto-restart correctly suppressed on intentional kill (the process-level exit handlers and
`exit-hook` callbacks are process singletons, registered once — not per instance).

---

## 3. The library logs to stdout

`threadedclass` and parts of `atem-connection` log via `console.log`, which writes to
**stdout**. The sidecar's NDJSON IPC also owns `process.stdout` (`ipc-bridge.ts`), so one
stray library line corrupts the framing the UI parses — and our "all logs to stderr" rule
only governs *our* code, not dependencies.

**Best practice:** before constructing `Atem`, redirect `console.log` / `console.info` /
`console.debug` to stderr (or to the IPC log channel). This applies in **every** threading
mode — `threadedclass`'s parent-side logging uses `console.log` even single-threaded, so
disabling multithreading reduces but does not remove the risk. (Same as `ARCHITECTURE.md`
packaging warning #2.)

---

## Upstream issues & field reports

What the library's own (still-open) issue tracker says about all this — useful both as
corroboration and as a map of what is *not* fixed. Both core issues are **open since 2021**.

**Threading is acknowledged-awkward but here to stay (for now).** `threadedclass` is a small
Sofie-internal lib that the maintainer calls "not very popular [with] a few rough corners"
([#164]). They've tried to replace it: a `threads.js` idea ([#106]), a WASM/native child
([#136]), and an actual `comlink` rewrite PR ([#164]) — which sat open from **2024 until it
was closed unmerged in Feb 2026**. None shipped. So the worker-thread machinery (and its
sharp edges) is stable but not going away soon.

**Bundling the library breaks it — a recurring, unresolved failure.** Webpack/Electron users
repeatedly hit `Cannot find module '…/atemSocketChild'` or `'…/threadedclass-worker.js'`
once bundled or packed, because the worker is loaded by path at runtime ([#106], [#133],
[#125]). The maintainer is candid that making `worker_threads` play nicely with
webpack/Electron/browser "is not simple" ([#136]). What works:

- **Don't bundle the worker — ship it as a file.** The proven webpack fix is to mark
  `atemSocketChild` (and the threadedclass worker) as an *external* and copy the file into
  the output dir (`copy-webpack-plugin`), or build a second bundle target for it ([#106]).
  electron-vite's analog is emitting the worker via the `?modulePath` / `?worker` suffix.
- **asar:** 2.x breaks inside an asar; **3.0+ is asar-safe** ([#106]) — we're on 3.9.0.
- **Node-only — never bundle it into the WebView.** It won't run in a browser
  (`__dirname is not defined`) ([#168]). TallyBot is already correct here: the library lives
  in the Node sidecar, not the SvelteKit/Vite frontend.
- **Reference consumer:** Bitfocus Companion ships atem-connection in production without
  these reports ([#133]) — because it runs in a Node backend with files on disk, exactly the
  shape `tools/atem-probe` uses and the one Phase 5 should prefer.

**`disableMultithreaded` — the maintainer's own caveats.** It's offered as the escape hatch
but explicitly "likely to cause the connection to die when other cpu intensive stuff is
happening in your app" ([#125]); safety is load-dependent with no single safe timeout
([#136]). Conversely, in packed/constrained environments the *watchdog itself* can misfire
("Timeout when trying to restart after 1000"), and disabling multithreading was the fix
([#133]) — i.e. the watchdog's value is partly negated exactly where packaging is hardest.

**Net for TallyBot:** the bundler failures don't apply to our Node-sidecar-with-files-on-disk
shape; they'd only return if we went the single-binary (`pkg`/SEA) route. The real
`disableMultithreaded` question remains the ~20 ms event-loop budget (§1), and our loop is
well within it.

---

## 4. Transition tally: both sources are live during a mix

Confirmed on real hardware (ATEM Mini, `tallybot-atem-probe.log`, 2026-05-31). The
**current engine (`tallyFor`) does not handle this case** — it marks only `programInput`
as live during a transition. The findings and the required fix are documented here so
Phase 5 can implement it correctly.

### What the log shows

**Hard cuts** (CUT button or direct cut): a single `stateChanged` event where both
`programInput` and `previewInput` update atomically. There is no in-between state.

**Auto transitions** (AUTO button): three-phase event sequence:

1. **Transition start** — one event that changes *both* `previewInput` and
   `transitionPosition` together. `previewInput` jumps immediately to whatever source will
   be on preview *after* the cut completes. `programInput` is unchanged — it still shows the
   outgoing source.

2. **Mid-transition** — ~25 `stateChanged` events over ~960 ms, each carrying only
   `transitionPosition`. Interval ≈ 40 ms (≈25 Hz). The 30-frame ATEM Mini default at 30 fps
   gives ~1 s, consistent with this.

3. **Transition end** — one event carrying `transitionPosition`, `programInput`,
   `previewInput`, and `transitionPosition` again (see [library quirk](#library-quirk) below).
   `programInput` now holds the incoming source; `previewInput` may change again for the next
   queued source.

### What `transitionPosition` looks like

The library type is:

```typescript
interface TransitionPosition {
  readonly inTransition: boolean;   // true while the mix is in progress
  readonly remainingFrames: number; // frames left in the transition
  handlePosition: number;           // 0–10000 (0 = idle, 10000 = complete)
}
```

`mixEffects[0].transitionPosition.inTransition` is the canonical "is a transition in
progress?" flag. `handlePosition > 0` is not sufficient — the library might briefly report a
non-zero position after the flag has cleared on the completion frame.

### Tally implication

During a transition (`inTransition = true`) both camera sources are being mixed together
on the output. An operator watching either source needs to see **live** (red), not preview
(green) or idle. The current `tallyFor` only marks `programInput` live:

```typescript
if (inputId === source.programInput) return "live";
if (inputId === source.previewInput) return "preview"; // ← wrong during transition
```

During `inTransition`:
- `programInput` = the **outgoing** source → live (being mixed out)
- the **incoming** source (being mixed in) → also live
- `previewInput` (current, after the phase-1 jump) = the **next queued** source → preview

The engine must mark both as live.

### The incoming-source tracking problem

The awkward part: `previewInput` changes at the *start* of the transition, before the mix
finishes. So at any point mid-transition, the current `snapshot.previewInput` is already the
next-queued source — not the incoming one. The incoming source is what `previewInput` was
*before* the phase-1 event.

`AtemSource` must therefore snapshot the previous preview value and hold it as
`incomingInput` for the duration of the transition:

- When `stateChanged` arrives with both `previewInput` and `transitionPosition` in the same
  paths list and `inTransition` is now `true`: capture the old `previewInput` as
  `incomingInput`.
- When `inTransition` becomes `false`: clear `incomingInput`.

### Required changes (Phase 5)

1. **`AtemMixEffect` interface** (`atem.ts`): add the transition slice:

   ```typescript
   export interface AtemTransitionPosition {
     inTransition?: boolean;
     handlePosition?: number;
     remainingFrames?: number;
   }
   export interface AtemMixEffect {
     programInput?: number;
     previewInput?: number;
     transitionPosition?: AtemTransitionPosition;
   }
   ```

2. **`SourceSnapshot`** (`engine.ts`): expose the transition state the engine needs:

   ```typescript
   export interface SourceSnapshot {
     // … existing fields …
     inTransition: boolean;
     /** The source being mixed in during a transition, or null when not in transition. */
     incomingInput: number | null;
   }
   ```

3. **`AtemSource`** (`atem.ts`): track previous preview on transition start and clear on end.
   Detection: in `#refresh()`, when `transitionPosition.inTransition` flips to `true`, record
   the *previous* `#previewInput` as the incoming source. When it flips back to `false`,
   clear it.

4. **`tallyFor`** (`engine.ts`): mark both outgoing and incoming sources live during a
   transition:

   ```typescript
   if (source.inTransition) {
     if (inputId === source.programInput) return "live";   // outgoing
     if (inputId === source.incomingInput) return "live";  // incoming
     if (inputId === source.previewInput) return "preview"; // next queued
     return "idle";
   }
   ```

5. **`engine.test.ts`**: add transition cases — `inTransition: true` with
   `programInput ≠ incomingInput`, both should return `"live"`, neither should return
   `"preview"`.

### Library quirk

On the transition-completion event, `transitionPosition` appears **twice** in the
`pathsChanged` array (confirmed on lines 61, 86, 111, and 136 of the probe log):

```
stateChanged: video.mixEffects.0.transitionPosition,
              video.mixEffects.0.programInput,
              video.mixEffects.0.previewInput,
              video.mixEffects.0.transitionPosition   ← duplicate
```

**These are genuine duplicates of one property — not a per-camera split.** Confirmed by
reading the library source:

- `TrPs` (`TransitionPositionUpdateCommand`) carries no input dimension — only
  `{ mixEffect, inTransition, remainingFrames, handlePosition }`
  (`TransitionPositionCommand.js`, `deserialize`). The ATEM models a transition as a single
  mix between program and preview with one 0–10000 handle; there is no separate
  program/preview transition position.
- `applyToState` returns a path keyed *only* by ME index:
  `` `video.mixEffects.${mixEffect}.transitionPosition` ``. Both entries in the log are the
  identical `video.mixEffects.0.transitionPosition` string — same ME, same property.
- The library concatenates each command's path with **no dedup**
  (`atem.js`: `allChangedPaths.push(...)` per command). Two identical entries therefore mean
  **two `TrPs` commands in the same UDP packet** — and only `TrPs` produces that path.

Why two only at completion: the final packet coalesces two animation frames' worth of `TrPs`
(the last movement frame + the reset-to-0 / `inTransition: false` frame — the same packet
that carries the program/preview swap, which is why mid-transition events show a *single*
`transitionPosition` and only the completion event doubles). Each `TrPs` is a full state
replacement (`mixEffect.transitionPosition = this.properties`), so the last one wins and the
emitted state object holds the correct final `inTransition: false`.

**Impact:** any code that checks `pathsChanged.includes('…transitionPosition')` or reads the
final `state` object is safe — duplicates don't cause double-processing. But logic that
*counts* paths or assumes unique entries would break. Treat `pathsChanged` as a set.

### Network scan confirmed working

The probe scanned 253 addresses across one subnet and found the ATEM Mini at 192.168.0.180
in 16 seconds. The connection handshake itself took ~15 ms. The full-app ATEM discovery
should reuse the same scan logic (it lives in the probe's `src/scanner.ts`).

---

## 5. Program/preview can be a non-camera source

`programInput` / `previewInput` (and, per §4, the transition `incomingInput`) can hold
**any ATEM source ID — not just the four HDMI cameras.** The director can put black, a
still, a media player, colour bars, or an ME output on program or preview. Observed in the
field when selecting **Still** or **Black** on the ATEM Mini.

ATEM Mini source IDs (the ones that aren't cameras 1–4):

| ID | Source |
|---|---|
| `0` | Black |
| `1000` | Colour Bars |
| `2001`, `2002` | Colour Generators 1–2 |
| `3010`, `3020` | Media Players 1–2 (**stills**) |
| `7001`, `7002` | ME 1 Program / Preview |

### Current code is already correct — this is an invariant to *preserve*, not a bug to fix

Verified end-to-end; nothing crashes today. Documented so it stays that way (the §4
transition work adds a new source-ID path — `incomingInput` — that must keep this property).

- **Input list filters non-cameras out.** `DEFAULT_INPUT_FILTER = id >= 1 && id < 1000`
  (`atem.ts`) excludes black (0) and every internal source (≥ 1000), so none of the above
  ever appears as a tally-able input row.
- **The engine treats program/preview as opaque numbers.** `tallyFor` is pure numeric
  comparison. Black/still on program is a valid **non-null** ID, so it is *not* the `unknown`
  fault state — and since no camera ID matches it, every camera correctly reads `idle`. This
  is the right, safety-aligned answer: cut to black or a still and no physical camera is on
  air, so all lights go dim-white "you're clear" — no false "live", and a *known* clear, not
  a fault.
- **Production never resolves these IDs in the UI.** `AppState` (`ipc.ts`) carries
  per-input precomputed `tally` and `source.connection`, **not** the raw program/preview IDs,
  so the SvelteKit UI has no source→camera lookup to fail on.
- **The probe guards its one lookup.** `setTile` (`tools/atem-probe/src/ui.ts`) does
  `byId[inputId] ? inp.label : "Input " + inputId`, so black shows "Input 0" and a still
  shows "Input 3010" rather than throwing. (This is the "non-standard source" seen in the
  program/preview tile during the field test.)

### Rule for any new code

Never assume `programInput` / `previewInput` / `incomingInput` resolves to a known camera
input. Treat them as opaque source IDs: compare numerically, and guard every label lookup
with a fallback. Do **not** use the fault/`unknown` path for "program is a source I don't
recognise" — an unrecognised but *reported* source is a confident "no camera live" (idle),
not an untrustworthy source.

### Test to lock it in (Phase 5)

`engine.test.ts`: `programInput` set to `0`, `3010`, and `7001` with cameras 1–4 assigned —
every camera must read `idle` (never `live`, `preview`, or `unknown`). Combined with §4:
a transition whose `incomingInput` is `0`/a still must still leave the non-involved cameras
`idle` and not crash.

---

## Why atem-connection (not the official SDK or Videohub)

**Official Blackmagic SDK:** COM-based (Windows Component Object Model) — only works on
Windows and macOS, requires ATEM Software Control to be installed, and produces
unidiomatic C# via COM interop. atem-connection is cross-platform, has no install
dependency, and is significantly more actively maintained.

**Videohub TCP protocol (port 9990):** a simple text-based TCP interface that exposes
program/preview routing — sufficient for tally alone, but read-only. It cannot be used to
control the switcher. Rejected in favour of atem-connection which enables full control for
the future roadmap.

---

[#106]: https://github.com/Sofie-Automation/sofie-atem-connection/issues/106
[#125]: https://github.com/Sofie-Automation/sofie-atem-connection/issues/125
[#133]: https://github.com/Sofie-Automation/sofie-atem-connection/issues/133
[#136]: https://github.com/Sofie-Automation/sofie-atem-connection/issues/136
[#164]: https://github.com/Sofie-Automation/sofie-atem-connection/pull/164
[#168]: https://github.com/Sofie-Automation/sofie-atem-connection/issues/168
[#68]: https://github.com/Sofie-Automation/sofie-atem-connection/issues/68

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

On Node it's a `worker_threads` worker, falling back to a forked child process only on very
old Node (`manager.ts:869-873`). Either transport loads `atemSocketChild` **by file path at
runtime** — the root cause of packaging warning #1.

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
work? (b) can we keep the default *and* still package cleanly — i.e. solve warning #1 by
shipping `atemSocketChild` on disk rather than reaching for the flag? (c) if we disable, is
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

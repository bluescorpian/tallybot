# The Sidecar Pattern

How TallyBot runs a **Node.js process alongside the Tauri app**, why, and how the two
talk. This is the architectural reference for the sidecar; [`README.md`](README.md) is the
day-to-day dev guide, and [`ARCHITECTURE.md`](../../ARCHITECTURE.md) remains the source of
truth for the binary device protocol.

> **Status.** Phase 0 ships only the **shared contracts** (`src/protocol.ts`,
> `src/ipc.ts`) and the sidecar's toolchain. The runtime wiring described below — the
> Tauri shell spawning the process, the stdio bridge, and packaging the binary — is
> **Phase 5** and is not built yet. It's documented here so the contracts make sense and
> Phase 5 has a target.

## Why a Node sidecar at all

The brain of TallyBot is inherently Node-shaped: the only maintained, cross-platform ATEM
library ([`atem-connection`](https://www.npmjs.com/package/atem-connection)) is a Node
package, and the rest of the networking (TCP server, UDP discovery) is done with Node
built-ins (`net`, `dgram`). Tauri's own backend is Rust, so rather than reimplement the
ATEM protocol in Rust, we run that logic as a **Node child process the Tauri shell owns** —
the standard [Tauri sidecar pattern](https://v2.tauri.app/learn/sidecar-nodejs/).

The sidecar is the **brain**; the Tauri Rust shell is a thin host and message bridge; the
Svelte UI is a pure view. Responsibilities don't bleed across those lines.

## Data flow

```
  ATEM Mini ──UDP 9910──┐
                        ▼
  ┌─────────────────────────────────────────────┐
  │ Node sidecar  (the brain)                    │   TCP 7000 / UDP 7001
  │  • atem-connection                           │ ◀──────────────────────▶  ESP32 devices
  │  • tally engine  (state → per-device colour) │        (binary protocol,
  │  • TCP server + UDP discovery                │         src/protocol.ts)
  └───────────────▲───────────────┬──────────────┘
       UI commands │               │ state events
        (NDJSON)   │               │  (NDJSON)          ← contract: src/ipc.ts
  ┌───────────────┴───────────────▼──────────────┐
  │ Tauri Rust shell  (host + bridge)            │      stdin/stdout
  └───────────────▲───────────────┬──────────────┘
        invoke()   │               │  emit() / listen()  ← Tauri IPC
  ┌───────────────┴───────────────▼──────────────┐
  │ Svelte UI  (view)                            │
  └──────────────────────────────────────────────┘
```

Two protocols meet in the sidecar and must not be confused:

- **Down to devices** — the length-prefixed **binary** protocol (`src/protocol.ts`,
  specified in `ARCHITECTURE.md`). The sidecar is the TCP *server*; devices connect to it.
- **Up to the UI** — **NDJSON over stdio** (`src/ipc.ts`), bridged by the Rust shell to
  Tauri's event/command IPC.

## Transport: newline-delimited JSON over stdio

The sidecar is **long-lived** (it holds the ATEM connection and the device servers open for
the whole session), so it is **spawned**, not invoked per-call. Tauri's guide steers
long-lived sidecars to either stdin/stdout or a localhost server; we use **stdio**:

- **Simplest, and Node-built-in** — `process.stdin` / `process.stdout`, no framework.
- **No extra listening port** on the user's machine, nothing to firewall or collide.
- One JSON object per line (see `serializeMessage` / `parseEvent` / `parseCommand` in
  `src/ipc.ts`). Lines are independent, so a partial read just waits for its newline.

Keep `stdout` for protocol messages only; log diagnostics to `stderr` so they never corrupt
the stream.

### The Rust bridge (Phase 5 shape)

The shell spawns the sidecar and pumps bytes both ways, translating to Tauri IPC:

```rust
// illustrative — Phase 5
let (mut rx, mut child) = app.shell().sidecar("tallybot-sidecar")?.spawn()?;
tauri::async_runtime::spawn(async move {
  while let Some(event) = rx.recv().await {
    if let CommandEvent::Stdout(line) = event {
      app.emit("sidecar", String::from_utf8_lossy(&line))?; // → UI listen("sidecar")
    }
  }
});
// UI → sidecar: a #[tauri::command] writes a serialized UiCommand to child.write(..)
```

The UI then `listen`s for `SidecarEvent`s and `invoke`s a command that forwards
`UiCommand`s. Both ends import the **same types** from `src/ipc.ts`.

## The shared contracts (Phase 0, implemented)

- **`src/protocol.ts`** — the binary device↔server codec and constants (framing, encoders,
  decoder, discovery, versioning). Mirrors `ARCHITECTURE.md`; keep its values in sync with
  the firmware `#define`s.
- **`src/ipc.ts`** — the UI↔sidecar schema. Its nouns mirror `GOALS.md` (source / input /
  device / program-gate) so the schema, persisted state, and UI line up. The UI imports
  these **type-only** via the `$ipc` alias (`../svelte.config.js`), so nothing from the
  sidecar reaches the browser bundle.

## Toolchain and conventions

- **Runtime:** Node ≥ 22.6 runs `.ts` directly via native type stripping — no bundler or
  dev runner in the loop. **Tests:** the built-in `node:test`. **Typecheck:** `tsc
  --noEmit` (stripping erases types but does not check them). Only `typescript` +
  `@types/node` are dev deps; there are no runtime deps until `atem-connection` (Phase 2).
- **Stay erasable.** Type stripping only *removes* types, it never *transforms* code, so
  the sidecar must avoid non-erasable TypeScript — no `enum`s, `namespace`s, or constructor
  parameter properties (use `as const` objects + union types). `tsconfig.json`'s
  `erasableSyntaxOnly` enforces this at typecheck time.
- **Isolated pnpm root.** The sidecar has its **own** `pnpm-workspace.yaml`,
  `node_modules`, and lockfile, deliberately *not* joined to the app's pnpm workspace. If
  it were a workspace member, pnpm would hoist the sidecar's `@types/node` into the
  app and type Node globals in the browser-targeted UI — which breaks the app's
  `pnpm run check`. Isolation keeps the Node-targeted and browser-targeted type
  environments apart. (`cd app/sidecar && pnpm install` still works.)

## Packaging (Phase 5)

Tauri's `externalBin` can only bundle a **self-contained binary**, so the sidecar is
compiled — a bundler (e.g. esbuild) to a single JS file, then
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) or Node's SEA to an executable. Wiring it
into the shell then means:

1. Add the Tauri **shell plugin** (Cargo dep + `tauri_plugin_shell::init()` in
   `src-tauri/src/lib.rs`).
2. Grant the capability in `src-tauri/capabilities/default.json`: `shell:allow-spawn`
   with `{ "name": "binaries/tallybot-sidecar", "sidecar": true }`.
3. Declare `bundle.externalBin: ["binaries/tallybot-sidecar"]` in `tauri.conf.json`.
4. Place the built binary at `src-tauri/binaries/tallybot-sidecar-<target-triple>` (get the
   triple with `rustc --print host-tuple`).
5. Spawn + bridge stdio in `lib.rs`, and manage the child's lifecycle with the app window.

The shipped binary also needs the NVIDIA+Wayland `WEBKIT_DISABLE_DMABUF_RENDERER=1`
workaround the dev shell already applies (see the repo `CLAUDE.md`).

## References

- [Tauri — Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)
- [Tauri — Embedding external binaries](https://v2.tauri.app/develop/sidecar/)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — binary protocol (source of truth) ·
  [`GOALS.md`](../../GOALS.md) — the model the IPC schema mirrors ·
  [`PHASES.md`](../../PHASES.md) — where this sits in the build

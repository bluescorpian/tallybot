# The Sidecar Pattern

How TallyBot runs a **Node.js process alongside the Tauri app**, why, and how the two
talk. This is the architectural reference for the sidecar; [`README.md`](README.md) is the
day-to-day dev guide, and [`src/protocol.ts`](src/protocol.ts) is the source of truth for
the binary device protocol.

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

- **Down to devices** — the length-prefixed **binary** protocol (`src/protocol.ts`). The sidecar is the TCP *server*; devices connect to it.
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

### The Rust bridge

The shell spawns the sidecar, pumps its stdio both ways and translates to Tauri IPC
(`src-tauri/src/sidecar.rs`): sidecar stdout lines become events the UI `listen`s to, and a
Tauri command writes the UI's `UiCommand`s to the child's stdin. Both ends import the
**same types** from `src/ipc.ts`. The same pipe carries the shell's own USB messages: the
shell owns every serial port and forwards cabled devices' frames to the sidecar
(`usbFrame` in, `usbSend` out; typed in `src/usb-bridge.ts`), so USB devices, and ESP-NOW
lights relayed through a cabled bridge, reach the engine without the sidecar touching a
port.

## The shared contracts

- **`src/protocol.ts`** — the binary device↔server codec and constants (framing, encoders,
  decoder, discovery, versioning). Keep its values in sync with the firmware `#define`s.
- **`src/ipc.ts`** — the UI↔sidecar schema. Its nouns (source / input /
  device / program-gate) are shared by the schema, persisted state, and UI. The UI imports
  it (types and the NDJSON codec) via the `$ipc` alias, and `protocol.ts` via `$protocol`
  (`../svelte.config.js`), so both must stay free of Node imports to bundle for the browser.

## Toolchain and conventions

- **Runtime:** in development Node ≥ 22.6 runs `.ts` directly via native type stripping — no
  bundler or dev runner in the loop (only the release build bundles; see Packaging). **Tests:** the built-in `node:test`. **Typecheck:** `tsc
  --noEmit` (stripping erases types but does not check them). The lone runtime dependency
  is `atem-connection`; `typescript` + `@types/node` are the dev deps. (`atem-connection`'s
  native `@julusian/freetype2` is deliberately left unbuilt — `new Atem()` loads it lazily
  and the sidecar never uses its media features; see `pnpm-workspace.yaml`.)
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

## Packaging

Tauri's `externalBin` can only bundle a **self-contained binary**, so releases compile the
sidecar: `build.mjs` (run by `pnpm run build:binary`, which `tauri.conf.json`'s
`beforeBuildCommand` calls) esbuild-bundles `src/main.ts` with `atem-connection` left
external, then packs it with the Node runtime via
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) into
`src-tauri/binaries/tallybot-sidecar-<target-triple>`. The shell spawns it as the
`externalBin` and manages its lifecycle in `src-tauri/src/sidecar.rs`.

The lifecycle is tied in both directions. The shell respawns a sidecar that dies (with
backoff) and shows the operator a fault until it's back, because a dead engine is otherwise
invisible behind a stale board. The sidecar exits when its stdin reaches EOF, because a
shell killed without running its exit hook would otherwise leave an orphan holding TCP
7000 / UDP 7001, and the next launch couldn't bind.

On Linux with NVIDIA + Wayland, WebKitGTK needs `WEBKIT_DISABLE_DMABUF_RENDERER=1`. The dev
shell sets it (`flake.nix`); `sidecar.rs` sets it on the spawned sidecar.

## References

- [Tauri — Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)
- [Tauri — Embedding external binaries](https://v2.tauri.app/develop/sidecar/)

# Sidecar

The TallyBot **brain**: it connects to the ATEM, runs the TCP server + UDP discovery,
maps device MACs to ATEM-input assignments, and translates ATEM state into `SET_COLOR`
commands. The Tauri shell spawns it as a long-lived [sidecar process][tauri-sidecar] and
bridges its stdin/stdout (newline-delimited JSON, the `ipc.ts` schema) to the Svelte UI.

See [`SIDECAR.md`](SIDECAR.md) for the architecture — why a Node sidecar, the stdio IPC
bridge, the toolchain decisions, and what packaging it (Phase 5) entails.

## What's inside

Two shared **contracts** (also imported by `tools/` and, type-only, by the UI):

- [`src/protocol.ts`](src/protocol.ts) — the binary device↔server wire protocol
  (codec + constants). Keep its values in sync with the firmware `#define`s.
- [`src/ipc.ts`](src/ipc.ts) — the UI↔sidecar IPC schema (`source` / `input` / `device`
  / program-gate), mirroring `GOALS.md`.

…and the **runtime** that turns them into a working brain. The pieces each do one job and
the orchestrator wires them together: a **pure tally engine** (switcher state + assignments
→ per-device colour and the UI snapshot), a **device server** (the TCP server and UDP
discovery, tracking devices by MAC with heartbeat timeouts), an **ATEM adapter** (the real
`atem-connection` behind a thin seam, normalised into engine input), a **config store**
(assignments + ATEM IP persisted to disk so they survive restarts), and the **IPC bridge**
(NDJSON over stdio). The orchestrator merges live and persisted state, runs the engine, and
sends a `SET_COLOR` only to devices whose colour actually changed. When the source
can't be trusted (ATEM disconnected, reconnecting, or not yet reporting program), an
assigned device is driven to a **flashing-blue fault** rather than a misleading
idle-green — the orchestrator owns that blink, since the engine is pure (see
`ARCHITECTURE.md` "Failure signalling").

The ATEM seam (`AtemLike`) is why hardware-free testing works: the Phase 1 `FakeAtem`
drops in for the real switcher unchanged. The full path is exercised end-to-end against the
simulators in [`tools/`](../../tools) — including a `sidecar-dev` runner you can drive by hand.

## Develop

Needs Node ≥ 22.6 (the flake pins Node 22). The only runtime dependency is
[`atem-connection`](https://www.npmjs.com/package/atem-connection).

```bash
pnpm install        # atem-connection + typescript/@types/node
pnpm test           # node:test, running .ts via native type stripping
pnpm run typecheck  # tsc --noEmit
pnpm start          # run the sidecar (real ATEM); speaks NDJSON on stdin/stdout
```

`atem-connection` pulls in `@julusian/freetype2`, a native module used only for its
media/text features, which the sidecar never touches. We deliberately don't build it (see
[`pnpm-workspace.yaml`](pnpm-workspace.yaml)): `new Atem()` loads it lazily, so leaving it
unbuilt is harmless — and its prebuilt binary wouldn't exec under this box's stub nix-ld
anyway.

There is no build step yet. The source runs directly under Node's native type stripping,
which only **erases** types — it never transforms code — so the sidecar must stay
**erasable**: no `enum`s, `namespace`s, or constructor parameter properties (use `as const`
objects + union types instead). `tsconfig.json`'s `erasableSyntaxOnly` enforces this.
Packaging into a standalone binary (a bundler + [pkg]/SEA) is a Phase 5 concern.

[tauri-sidecar]: https://v2.tauri.app/learn/sidecar-nodejs/
[pkg]: https://github.com/yao-pkg/pkg

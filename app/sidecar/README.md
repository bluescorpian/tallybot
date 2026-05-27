# Sidecar

The TallyBot **brain**: it connects to the ATEM, runs the TCP server + UDP discovery,
maps device MACs to ATEM-input assignments, and translates ATEM state into `SET_COLOR`
commands. The Tauri shell spawns it as a long-lived [sidecar process][tauri-sidecar] and
bridges its stdin/stdout (newline-delimited JSON, the `ipc.ts` schema) to the Svelte UI.

See [`SIDECAR.md`](SIDECAR.md) for the architecture — why a Node sidecar, the stdio IPC
bridge, the toolchain decisions, and what packaging it (Phase 5) entails.

**Phase 0 ships only the shared contracts** — everything else (ATEM, engine, servers)
arrives in Phase 2.

- [`src/protocol.ts`](src/protocol.ts) — the binary device↔server wire protocol
  (codec + constants). Keep its values in sync with the firmware `#define`s.
- [`src/ipc.ts`](src/ipc.ts) — the UI↔sidecar IPC schema. The UI imports these types
  via the `$ipc` alias (see `../svelte.config.js`); the `import type` is erased at build.

## Develop

Needs Node ≥ 22.6 (the flake pins Node 22). No runtime dependencies yet.

```bash
pnpm install        # typescript + @types/node only
pnpm test           # node:test, running .ts via native type stripping
pnpm run typecheck  # tsc --noEmit
```

There is no build step here yet. The source runs directly under Node's native type
stripping, which only **erases** types — it never transforms code — so the sidecar must
stay **erasable**: no `enum`s, `namespace`s, or constructor parameter properties (use
`as const` objects + union types instead). `tsconfig.json`'s `erasableSyntaxOnly` enforces
this. Packaging into a standalone binary (a bundler + [pkg]/SEA) is a Phase 5 concern.

[tauri-sidecar]: https://v2.tauri.app/learn/sidecar-nodejs/
[pkg]: https://github.com/yao-pkg/pkg

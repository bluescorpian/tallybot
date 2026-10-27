# Tools — hardware-free simulators

Stand-ins for the two pieces of hardware TallyBot talks to, so the rest of the system
can be built and exercised without an ATEM switcher or an ESP32 on the bench. Both are
built against the contracts in [`app/sidecar/src`](../app/sidecar/src) (the binary protocol
and its constants), so they speak exactly the spec'd wire format.

## ATEM simulator

A stub of the [`atem-connection`](https://www.npmjs.com/package/atem-connection) library
(`atem-sim.ts`, the `FakeAtem` class). It exposes the slice of that library's API the
sidecar uses — `connect`/`disconnect`, the `connected` / `disconnected` /
`stateChanged` events, `state.video.mixEffects[0].programInput`/`previewInput`, the input
names in `state.inputs[id]`, and `changeProgramInput`/`changePreviewInput` — backed by
configurable in-memory state. The dev sidecar entries swap the real `Atem` for this and are
otherwise unchanged.

`atem-sim-cli.ts` drives it from the terminal and prints the per-input tally each change
implies (the same live/preview/idle the sidecar's engine will derive):

```bash
pnpm atem-sim                     # 4 inputs, program 1 / preview 2
pnpm atem-sim -- --inputs 6 --program 2
```

Interactive commands: `pgm <n>`, `pvw <n>`, `cut` (program/preview swap), `name <id>
<text>` (rename an input — the label tally inherits), `ls`, `q`.

## Tally client simulator

A fake ESP32 tally device (`tally-client.ts`). It does what a WiFi light does on the wire:
discover the server over UDP, open a TCP connection, send `HELLO` then periodic
`HEARTBEAT`s, and act on the `SET_COLOR` commands it receives, logging each.
That exercises the whole server-side path (discovery, the TCP server, the engine) without
hardware.

```bash
pnpm tally-client                            # discover a server, then connect
pnpm tally-client -- --host 127.0.0.1        # connect directly, skipping discovery
pnpm tally-client -- --count 4               # four devices with adjacent MACs
pnpm tally-client -- --mac aa:bb:cc:dd:ee:ff --version 1
```

A single device in an interactive terminal also gets a control REPL: `s`ilence / `r`esume
heartbeats (to test the server's heartbeat-timeout), `d`rop the connection (to test
reconnection), `?` status, `q`uit. It reconnects on its own when the link drops.

The device half of the binary protocol — encode `HELLO`/`HEARTBEAT`, decode
`SET_COLOR` — lives in `device-protocol.ts`. It's the mirror of the sidecar's
server-side `protocol.ts` and reuses that file's constants and framing, so there's one
source of truth for the wire format. (It's also the TypeScript counterpart of what the
firmware implements in C++.)

## Sidecar dev runner

`sidecar-dev-cli.ts` builds the **real sidecar** — orchestrator, tally engine, TCP device
server, ATEM adapter, store — through the same `createSidecar` (`app/sidecar/src/wiring.ts`)
that production uses, TCP transport only, with the `FakeAtem` above in place of the real
`Atem` and a terminal REPL in place of the NDJSON-over-stdio UI. So you can drive the switcher and assign devices by hand and watch the
colours land on real `tally-client` simulators: the whole `ATEM → sidecar → device` flow
with nothing plugged in. It binds the real ports (TCP 7000 / UDP 7001), so the simulators
(or actual ESP32s on the LAN) connect to it normally.

```bash
pnpm sidecar-dev                  # start the sidecar against a simulated ATEM
# then, in another terminal:
pnpm tally-client -- --count 2    # two fake devices discover + connect
```

REPL commands: `pgm <n>` / `pvw <n>` / `cut` / `name <id> <text>` drive the switcher;
`assign <mac> <n>` / `unassign <mac>` / `flash <mac>` / `bright <mac> <n>` are the UI
actions (the `<mac>` may be a short tail); `ls` reprints the board, `q` quits. The same
TCP-only stack is asserted automatically in `sidecar-e2e.test.ts`. It has no USB or ESP-NOW
transport (those need the Rust shell); for real hardware use `cargo tauri dev`, below.

## `cargo tauri dev` entry

`sidecar-fake-main.ts` is the sidecar `cargo tauri dev` spawns: the production stack from
`createSidecar`, USB and ESP-NOW included, against a `FakeAtem`, so real devices can be
tested without a switcher. It adds only the dev-only parts: `dev: true` snapshots, the
`setProgram` command that drives the fake switcher, and device logs mirrored to stderr.

## Develop

Needs Node ≥ 22.6. Same toolchain as the sidecar: the source runs directly under Node's
native type stripping (no build step), so it must stay **erasable** (no `enum`s,
`namespace`s, etc.). The codec imported from `app/sidecar/src` is pulled into this program
too, by design.

```bash
pnpm install        # typescript + @types/node only
pnpm test           # node:test, including loopback TCP/UDP integration tests
pnpm run typecheck  # tsc --noEmit
```

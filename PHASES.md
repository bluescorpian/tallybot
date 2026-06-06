# TallyBot — Build Phases

This document scopes the build into phases: *what* each phase covers, *what it depends
on*, and *what "done" looks like* — not how to build it, and not any design decisions.
Design rationale, the binary protocol, and the IPC schema specifics live in
[`ARCHITECTURE.md`](ARCHITECTURE.md); keep the two consistent.

Each phase carries a coarse **Status** (✅ done · 🔄 in progress · ⬜ not started) and
**Acceptance criteria** — the checks that decide the phase is complete. The detailed,
prose live-status narrative stays in `CLAUDE.md` ("## Status"); the marker here is just
the at-a-glance roll-up.

## How the phases relate

Phase 0 establishes the contracts that let everything else be built in isolation. Once
those exist, three tracks run in parallel — **firmware**, **sidecar**, and **UI** —
each developed against its own contract, not against the others' internals. The
simulators unblock end-to-end testing of the sidecar and UI without physical hardware.

```
Phase 0  shared contracts
   │
   ├── Phase 1  simulators ──┐
   │                         │ (unblock hardware-free testing)
   ├── Phase 2  sidecar  ◀───┤
   ├── Phase 3  firmware ◀───┘   (parallel)
   └── Phase 4  UI               (parallel)
            │
        Phase 5  shell & packaging
            │
        Phase 6  roadmap (deferred)
```

---

## Phase 0 — Shared contracts · ✅ done

The interfaces every other phase builds against. Until these exist, the islands cannot
be developed independently.

**Scope**
- The binary protocol codec and constants on the sidecar side (encode/decode device and
  server messages; discovery messages).
- The Tauri IPC event schema — the contract between the Svelte UI and the sidecar.

**Depends on:** nothing.

**Acceptance criteria**
- Binary codec exists with constants matching `ARCHITECTURE.md`: framing `[len][payload…]`,
  message types, ports (TCP 7000 / UDP 7001), versioning (`CURRENT` / `MIN_SUPPORTED`),
  and the standard colours. → `app/sidecar/src/protocol.ts`.
- IPC schema (`AppState`, `SidecarEvent`, `UiCommand`) defined as the single shared *type*
  contract, imported type-only by the UI. → `app/sidecar/src/ipc.ts`.
- A `FrameDecoder` reassembles length-prefixed frames across split/coalesced TCP chunks;
  encode→decode round-trips as identity; malformed/short payloads are rejected.
- Tests cover the above (`protocol.test.ts`, `ipc.test.ts`).

---

## Phase 1 — Simulators (`tools/`) · ✅ done

Hardware-free stand-ins so the rest of the system can be exercised without an ATEM or an
ESP32 on the bench.

**Scope**
- ATEM simulator: stands in for the ATEM integration, with controls to drive
  program/preview state.
- Tally client simulator: connects over TCP as a device would, with a configurable
  identity, and logs the commands it receives.

**Depends on:** Phase 0.

**Acceptance criteria**
- A `FakeAtem` satisfies the sidecar's `AtemLike` seam and exposes controls to set
  program/preview, emitting the state changes the sidecar consumes.
- A tally-client simulator performs UDP discovery, opens a TCP connection with a
  configurable MAC/version, sends HELLO + heartbeats, and logs received SET_COLOR /
  IDENTIFY (the device side of the protocol — `tools/src/tally-client.ts`).
- The two compose into an end-to-end run with no hardware (`tools/src/sidecar-e2e.test.ts`,
  the `sidecar-dev` REPL), and this is the harness used to test Phases 2–4.

---

## Phase 2 — Sidecar (the brain) · ✅ done

The Node.js backend. Built against the Phase 0 contracts and tested against the Phase 1
simulators.

**Scope**
- Tally engine: the pure mapping from switcher state + camera assignments to per-device
  colour.
- Device connectivity: the TCP server and UDP discovery; tracking devices by identity;
  heartbeat/timeout handling; routing outgoing commands.
- ATEM integration: connecting to the switcher and translating its state changes into
  engine input.
- Assignment store: persisting the device-to-camera mapping so it survives restarts.
- IPC bridge: emitting state to the UI and handling commands from it, per the Phase 0
  schema.

**Depends on:** Phase 0; Phase 1 for end-to-end testing.

**Acceptance criteria**
- Engine maps switcher state + assignments to the correct per-device colour, including the
  fault rule: an untrusted source (ATEM disconnected/reconnecting, or connected but no
  program reported) drives assigned devices to flashing-blue **Fault**, never idle
  (`ARCHITECTURE.md` "Failure signalling").
- Device server: TCP on 7000; UDP discovery on 7001 (unicasts a reply to `TALLY_FIND`,
  broadcasts presence every 5s); tracks devices by MAC; a device silent for 30s is timed
  out and its socket closed (`HEARTBEAT_TIMEOUT_MS`, `ANNOUNCE_INTERVAL_MS`).
- ATEM adapter behind the `AtemLike` seam turns `stateChanged` into engine input; the real
  `atem-connection` lives only at that edge (`main.ts`).
- Assignments (MAC → input) persist to disk and survive a restart.
- IPC bridge emits whole `AppState` snapshots and applies every `UiCommand`; a device
  HELLO below `MIN_SUPPORTED` surfaces an "update firmware" notice.
- `pnpm start` runs the wired process; the suite passes against `FakeAtem` + fake device.

---

## Phase 3 — Firmware (`firmware/`) · ✅ done

The ESP32-C3 device firmware. Fully independent of the app once the protocol is fixed.

**Scope**
- WiFi provisioning (captive portal) and credential persistence.
- Discovery and connection to the server; reconnection on drop.
- The device side of the binary protocol: HELLO, heartbeats, and applying incoming
  commands.
- Driving the onboard LED.

**Depends on:** Phase 0 (protocol + discovery). Runs in parallel with Phases 2 and 4.
Testable end-to-end against the Phase 2 sidecar + Phase 1 `FakeAtem` — no ATEM required.

**Acceptance criteria**
- First boot (or failed credentials) raises a WiFiManager SoftAP captive portal
  (`TallyLight-XXXXXX`); credentials persist to NVS; AP re-arms only on later connect
  failure (`ARCHITECTURE.md` "WiFi Provisioning").
- Device broadcasts `TALLY_FIND` every 2s until it gets `TALLY_HERE:<port>`, opens TCP to
  that server, and reconnects on drop — re-sending HELLO each time.
- Wire protocol: sends HELLO `[version][MAC×6]` on connect and HEARTBEAT every 10s; decodes
  SET_COLOR / IDENTIFY via length-prefix framing. `firmware/src/protocol.h` `#define`s
  mirror `app/sidecar/src/protocol.ts` (kept in lockstep).
- LED: WS2812 driven via FastLED on **GPIO8**; renders every server colour; IDENTIFY
  flashes; loss of the server shows **device-local steady blue** (`ARCHITECTURE.md`
  "Failure signalling"). Honors the firmware gotchas (GPIO8 addressable, never sleep,
  TX-power fallback).
- End-to-end: a physical board provisions, appears in the UI by MAC, tracks
  live/preview/idle as program changes, flashes on IDENTIFY, and goes steady blue when the
  sidecar is killed.

---

## Phase 4 — Svelte UI (`app/src/`) · ✅ done

The desktop interface. Talks only to the sidecar over IPC; carries all the visual and
interaction design.

**Scope**
- Device list with status, camera assignment, and per-device controls.
- ATEM connection state and settings.
- The actions exposed over IPC (assign, identify, adjust, etc.).

**Depends on:** Phase 0 (IPC schema). Can be developed against mocked events ahead of a
finished sidecar; runs in parallel with Phases 2 and 3.

**Acceptance criteria**
- The board renders every `AppState` case from a `SidecarEvent` stream via the
  `boardState.ts` mapper: source lifecycle (connected / connecting / disconnected /
  unconfigured / connected-no-inputs) and every light state (assigned-live / preview /
  idle, unassigned/setup, offline, and flashing fault).
- Each user action maps to the right `UiCommand`: assign / unassign, identify, set
  brightness, set source IP. `NoticeEvent`s (e.g. firmware-outdated) are surfaced.

**Status detail:** complete. The board renders through `boardState.ts` from the **live
sidecar IPC stream** (`src/lib/ipc.svelte.ts`), with a mock `AppState` kept as a non-Tauri
fallback so the `/preview` design workflow still works. Every action maps to its `UiCommand`
(assign / unassign / identify / setBrightness / setSource), the settings ATEM **Scan** runs
the real subnet sweep (`scanSources` → `sourceScan`), and `NoticeEvent`s surface in a banner.

---

## Phase 5 — Shell & packaging · 🔄 in progress (bridge done; packaging proven, Windows test pending)

Wiring the islands into a shippable application.

**Scope**
- Tauri shell: sidecar process lifecycle and IPC forwarding.
- Production builds and platform packaging, including the NVIDIA + Wayland workaround
  for the shipped binary.

**Depends on:** Phases 2 and 4.

**Acceptance criteria**
- ✅ The Tauri shell spawns the sidecar as a child, bridges its stdout → UI (`emit`/`listen`
  on a `"sidecar"` channel) and `UiCommand` → its stdin (the `send_to_sidecar`
  `#[tauri::command]` the UI `invoke`s), and ties the child's lifecycle to the app
  (killed on exit) — `lib.rs`, `SIDECAR.md` "The Rust bridge". The `console.log`/`info`/`debug`
  → stderr redirect is in place (warning 2) so no library line corrupts the IPC stream.
  Spawned from Rust via `tauri-plugin-shell`, so no frontend shell capability is needed; the
  dev spawn runs `node` on the sidecar source, while a shippable build spawns the packaged
  `externalBin` via `app.shell().sidecar(...)` (the `else` branch in `spawn_sidecar`).
- ✅ A packaging strategy that ships the sidecar with the app — **single self-contained
  binary**, decided and proven. Single-binary (`@yao-pkg/pkg`) was *re-tested* and found to
  work after all: esbuild bundles the sidecar with `atem-connection` left **external** (so
  its socket worker stays a real file pkg can trace into the snapshot — `ARCHITECTURE.md`
  warning 1), then pkg packs it into `binaries/tallybot-sidecar-<triple>`, spawned via
  `app.shell().sidecar(...)`. Verified end-to-end with the default **multithreaded**
  `atem-connection` — no freetype2 stub, no `atemSocketChild` copy, no `disableMultithreaded`
  (warning 3 resolved). The `console.log`/`info`/`debug` → stderr redirect is in place
  (warning 2); native deps ship per-tarball and the Node runtime is pinned by pkg (warnings
  4–5). `build.mjs` runs from `beforeBuildCommand`; the binary is a git-ignored artifact.
- ⬜ **Build + test on Windows**, then zip exe + sidecar for the no-installer portable
  distribution. (The recipe is in `ARCHITECTURE.md` "Building a release"; only the Windows
  run itself is outstanding.)
- The shipped binary sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` (NVIDIA + Wayland workaround,
  `CLAUDE.md`).
- End-to-end: a built, packaged app launches, spawns its sidecar, shows live state, and
  drives real devices against a real ATEM — and runs on the dev NixOS box.

---

## Phase 6 — Roadmap (deferred) · ⬜ not started

Out of scope for the initial build; tracked here so the phases above stay focused.
Acceptance criteria for each item are defined when (and if) it's scheduled.

**Scope**
- Firmware OTA updates.
- Web UI accessible from other devices on the network.
- Multi-switcher support.
- Per-device colour customisation. (Per-device **brightness** is v1 — see Phase 4.)
- OBS integration (obs-websocket).

**Depends on:** a working baseline from Phases 2–5.

# TallyBot — Build Phases

This document scopes the build into phases: *what* each phase covers and *what it
depends on* — not how to build it, and not any design decisions. Design rationale, the
binary protocol, and the IPC schema specifics live in
[`ARCHITECTURE.md`](ARCHITECTURE.md); keep the two consistent.

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

## Phase 0 — Shared contracts

The interfaces every other phase builds against. Until these exist, the islands cannot
be developed independently.

**Scope**
- The binary protocol codec and constants on the sidecar side (encode/decode device and
  server messages; discovery messages).
- The Tauri IPC event schema — the contract between the Svelte UI and the sidecar.

**Depends on:** nothing.

---

## Phase 1 — Simulators (`tools/`)

Hardware-free stand-ins so the rest of the system can be exercised without an ATEM or an
ESP32 on the bench.

**Scope**
- ATEM simulator: stands in for the ATEM integration, with controls to drive
  program/preview state.
- Tally client simulator: connects over TCP as a device would, with a configurable
  identity, and logs the commands it receives.

**Depends on:** Phase 0.

---

## Phase 2 — Sidecar (the brain)

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

---

## Phase 3 — Firmware (`firmware/`)

The ESP32-C3 device firmware. Fully independent of the app once the protocol is fixed.

**Scope**
- WiFi provisioning (captive portal) and credential persistence.
- Discovery and connection to the server; reconnection on drop.
- The device side of the binary protocol: HELLO, heartbeats, and applying incoming
  commands.
- Driving the onboard LED.

**Depends on:** Phase 0 (protocol + discovery). Runs in parallel with Phases 2 and 4.

---

## Phase 4 — Svelte UI (`app/src/`)

The desktop interface. Talks only to the sidecar over IPC; carries all the visual and
interaction design.

**Scope**
- Device list with status, camera assignment, and per-device controls.
- ATEM connection state and settings.
- The actions exposed over IPC (assign, identify, adjust, etc.).

**Depends on:** Phase 0 (IPC schema). Can be developed against mocked events ahead of a
finished sidecar; runs in parallel with Phases 2 and 3.

---

## Phase 5 — Shell & packaging

Wiring the islands into a shippable application.

**Scope**
- Tauri shell: sidecar process lifecycle and IPC forwarding.
- Production builds and platform packaging, including the NVIDIA + Wayland workaround
  for the shipped binary.

**Depends on:** Phases 2 and 4.

---

## Phase 6 — Roadmap (deferred)

Out of scope for the initial build; tracked here so the phases above stay focused.

**Scope**
- Firmware OTA updates.
- Web UI accessible from other devices on the network.
- Multi-switcher support.
- Per-device brightness and colour customisation.
- OBS integration (obs-websocket).

**Depends on:** a working baseline from Phases 2–5.

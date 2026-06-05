# TallyBot — What's Next

The actionable remaining work to ship v1, in suggested order. This is the outstanding
*subset* — each phase's full scope and "done" criteria live in [`PHASES.md`](PHASES.md);
design rationale and the protocol live in [`ARCHITECTURE.md`](ARCHITECTURE.md).

Where things stand: the **firmware is done and hardware-verified** (Phase 3 — see below),
so the remaining v1 work is all in the **app**. The UI is built (board, settings drawer,
chrome) but runs on **mock data with stub handlers**, and the sidecar↔UI bridge (Phase 5)
isn't started yet. So the app is ~90% built but disconnected.

## UI (Phase 4 tail)

- [x] **Brightness control** — built as `BrightnessBar.svelte` in the `LightPicker`
  popover (flat amber bar, 10 levels, 0 = off, −/+ buttons, level centred; maps 0–10 ↔ the
  0–255 byte). `brightness` is threaded through the board view-model and an `onbrightness`
  handler runs the full chain `Board` → `BoardDock` → `LightPicker`, mock-wired in
  `+page.svelte`. **Remaining for Phase 5:** swap the mock for the real `setBrightness`
  command (already in `ipc.ts`) — see the bridge below; consider debouncing rapid ±/hold.

## App (Phase 5 — the sidecar↔UI bridge)

- [ ] **Build the connection (Tauri shell ↔ sidecar ↔ UI).** Three pieces:
  - `src-tauri/src/lib.rs` (still the `greet` template): add `tauri-plugin-shell`, spawn
    the sidecar, pump its stdout lines → `emit("sidecar")`, add a `#[tauri::command]` that
    forwards a `UiCommand` to the child's stdin, tie the child lifecycle to the window,
    pass `TALLYBOT_STATE_FILE`, and export `WEBKIT_DISABLE_DMABUF_RENDERER=1` for the
    shipped binary.
  - Config: `shell:allow-spawn` (scoped to the sidecar) in `capabilities/default.json`;
    `bundle.externalBin` in `tauri.conf.json`.
  - New `src/lib/ipc.ts`: `listen("sidecar")` → `parseEvent` → a reactive `AppState`
    store; plus a sender that `invoke`s the forward command per `UiCommand`. (`@tauri-apps/api`
    is already a dep — see `TitleBar.svelte`.)

- [ ] **Make the board + settings work on real data.** Replace the mock in `+page.svelte`
  (mock devices + the stub `assign` / `unassign` / `flash` / `setup` / `onSettingsSave`
  handlers) with the live store, and wire each handler to the IPC sender — including the
  settings panel's `onsave(ip)` → `setSource`.
  - **Decide:** the settings **"Scan"** button has no backend — there's no scan command in
    the IPC schema (`UiCommand` is only `setSource`). Ship it (needs an ATEM-scan command)
    or remove/defer it for v1.

- [ ] **Research packaging.** Open decision: single-binary (`pkg`/SEA) was tested and found
  impractical for `atem-connection`. Candidate is shipping JS + `node_modules` + a Node
  runtime as `externalBin`. **Does not block the Sunday test** — `cargo tauri dev` (and the
  test) can spawn `node` on the sidecar source; packaging only blocks a shippable build.
  See `PHASES.md` Phase 5 and `ARCHITECTURE.md` "Packaging the Sidecar".

## Firmware (Phase 3) — ✅ done

The full tally client is built (`firmware/`: `platformio.ini`, `src/protocol.h`,
`src/main.cpp`, `README.md`) and **verified on a physical ESP32-C3**: WiFiManager
captive-portal provisioning, UDP discovery, the TCP binary protocol (HELLO / heartbeat /
SET_COLOR / IDENTIFY via length-prefix framing), and the LED state machine — provision →
discover → connect → live/preview/idle tally → identify → per-device brightness, all
against the standalone `sidecar-dev` runner. `protocol.h` mirrors `app/sidecar/src/protocol.ts`,
and the perceptual brightness byte is **gamma-corrected on the device** (FastLED
`applyGamma_video`, γ≈2.5) — the single home for that correction, per `ARCHITECTURE.md`.

Only two live checks remain optional (behaviour is coded, just not yet exercised on the
bench): killing the server → device-local **steady blue**, and a multi-minute run off a USB
power bank → never sleeps.

---

**Suggested order (app only — firmware is done).** Build the bridge → wire the board +
settings to real data → packaging research (later). Once the bridge is in, `cargo tauri dev`
gives you the real app driving the real sidecar. Then the full hardware test: real app +
real boards, then swap `FakeAtem` for the real ATEM.

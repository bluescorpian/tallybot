# TallyBot — What's Next

The actionable remaining work to ship v1, in suggested order. This is the outstanding
*subset* — each phase's full scope and "done" criteria live in [`PHASES.md`](PHASES.md);
design rationale and the protocol live in [`ARCHITECTURE.md`](ARCHITECTURE.md).

The **app** and **firmware** are independent tracks that can be built **in parallel** —
firmware tests against the standalone sidecar (`pnpm start`), not the app, so neither
blocks the other (see the Firmware section).

Where things stand: the UI is built (board, settings drawer, chrome) but runs on **mock
data with stub handlers**, and the sidecar↔UI bridge (Phase 5) isn't started yet. So the
app is ~90% built but disconnected.

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

## Firmware (Phase 3 — runs in parallel with the app)

Not started (`firmware/` is empty). **Independent of the app** — develop and test it
against the standalone sidecar (`cd app/sidecar && pnpm start`) plus the `sidecar-dev`
REPL to drive tally state; no app bridge and no ATEM required. Full acceptance criteria
are in `PHASES.md` Phase 3; `tools/src/tally-client.ts` + `device-protocol.ts` are a
line-by-line reference for the device side of the wire.

- [ ] **Scaffold** the PlatformIO project: `firmware/platformio.ini` (ESP32-C3, Arduino,
  `fastled/FastLED` + `tzapu/WiFiManager`) and `firmware/src/main.cpp`.
- [ ] **`firmware/src/protocol.h`** — `#define`s mirroring `app/sidecar/src/protocol.ts`
  (ports, message types, version, colours, framing). Keep the two in lockstep.
- [ ] **WiFi provisioning** — WiFiManager SoftAP captive portal (`TallyLight-XXXXXX`),
  credentials in NVS, AP re-arms only on connect failure.
- [ ] **Discovery + TCP** — broadcast `TALLY_FIND` until `TALLY_HERE:<port>`, connect,
  reconnect on drop (re-sending HELLO).
- [ ] **Protocol** — send HELLO `[version][MAC×6]` + HEARTBEAT every 10s; decode
  SET_COLOR / IDENTIFY via length-prefix framing.
- [ ] **LED** — WS2812 via FastLED on **GPIO8**; render every server colour; IDENTIFY
  flash; device-local **steady blue** when the server is lost. Mind the firmware gotchas
  (GPIO8 addressable, never sleep, TX-power fallback — `CLAUDE.md`).
  - **Gamma-correct the brightness byte.** It's a *perceptual* value (`ARCHITECTURE.md` →
    SET_COLOR), so apply a gamma LUT (FastLED `dim8_video` / `applyGamma_video`, γ≈2.2–2.8)
    to it before driving the strip — otherwise the UI's even 0–10 levels look bunched at
    the dim end. This is the single home for the linearity correction; the sidecar and UI
    deliberately leave the byte uncorrected.
- [ ] **`firmware/README.md`** — the one new doc: build/flash/monitor on NixOS (PlatformIO
  via `nix run nixpkgs#platformio`) + the gotchas. Mirrors `app/sidecar/README.md`.

---

**Suggested order.** Two parallel tracks:
- **App:** brightness (quick — closes Phase 4) → build the bridge → wire the board +
  settings to real data → packaging research (later). Once the bridge is in,
  `cargo tauri dev` gives you the real app driving the real sidecar.
- **Firmware:** scaffold + `protocol.h` → WiFi/discovery/TCP → LED + failure states,
  tested against the standalone sidecar throughout.

Both converge for the hardware test: real app + real boards, then swap `FakeAtem` for the
real ATEM.

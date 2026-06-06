# TallyBot — What's Next

The actionable remaining work to ship v1, in suggested order. This is the outstanding
*subset* — each phase's full scope and "done" criteria live in [`PHASES.md`](PHASES.md);
design rationale and the protocol live in [`ARCHITECTURE.md`](ARCHITECTURE.md).

Where things stand: the **firmware is done and hardware-verified** (Phase 3) and the
**app now runs live** — `cargo tauri dev` drives the real UI against the real sidecar
(Phase 4 ✅, Phase 5 bridge ✅). **Packaging is solved** (single-binary sidecar, wired into
`cargo tauri build`); the only remaining v1 work is **building + testing it on Windows**.

## UI (Phase 4) — ✅ done

- [x] **Brightness control** — `BrightnessBar.svelte` in the `LightPicker` popover (flat
  amber bar, 10 levels, 0 = off, maps 0–10 ↔ the 0–255 byte), threaded through the board
  view-model and `onbrightness` (`Board` → `BoardDock` → `LightPicker`), now sending the
  real `setBrightness` command.
- [x] **Live IPC wiring** — board + settings run on the live sidecar stream
  (`src/lib/ipc.svelte.ts`): every action maps to its `UiCommand`, `NoticeEvent`s surface
  in a banner, and a mock fallback keeps the `/preview` workflow working when not under Tauri.
- [x] **Settings ATEM Scan** — shipped: `scanSources` command + `sourceScan` event
  (`ipc.ts`), the real subnet sweep in `app/sidecar/src/scanner.ts` (extracted from
  `tools/atem-probe`), wired into the Scan button.

## App (Phase 5 — the sidecar↔UI bridge)

- [x] **The connection (Tauri shell ↔ sidecar ↔ UI).** `src-tauri/src/lib.rs` registers
  `tauri-plugin-shell`, spawns the Node sidecar, pumps its stdout → `emit("sidecar")`,
  exposes the `send_to_sidecar` `#[tauri::command]` (UI → stdin), and kills the child on
  exit. `console.log`/`info`/`debug` → stderr redirect added so no library line corrupts
  the NDJSON stream. The frontend store + senders live in `src/lib/ipc.svelte.ts`.
  - *In dev, `lib.rs` spawns `node` on the sidecar source (fake-ATEM entry); a shippable
    build spawns the packaged `externalBin` instead.*

- [x] **Packaging — single binary (proven).** Myth busted: `@yao-pkg/pkg` + the default
  multithreaded `atem-connection` works — verified end-to-end (isolated repro, standalone
  sidecar, and the real Tauri app), no freetype2 stub / no `atemSocketChild` copy / no
  `disableMultithreaded`. `app/sidecar/build.mjs` (esbuild bundle with `atem-connection`
  external → pkg) emits `src-tauri/binaries/tallybot-sidecar-<triple>`; `lib.rs` spawns it
  via `app.shell().sidecar(...)` and points `TALLYBOT_STATE_FILE` at the OS app-data dir;
  `beforeBuildCommand` runs the build. Binary is git-ignored. See `ARCHITECTURE.md`
  "Packaging the Sidecar → Building a release".
  - [ ] **Build + test on Windows.** Run the release recipe on a Windows box
    (`pnpm -C sidecar install` → `cargo tauri build`), confirm the win-x64 sidecar binary
    boots and connects, then zip exe + sidecar for the no-installer portable distribution.

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

**What's left for v1.** Packaging is **solved** (single-binary sidecar, proven and wired);
the only packaging task left is **building + testing on Windows** and zipping the portable
distribution. Everything else is built: firmware is hardware-verified, `cargo tauri dev`
runs the real app driving the real sidecar, and `cargo tauri build` produces the packaged
sidecar. Next milestone is the **full hardware test** — real app + real boards against the
`FakeAtem`, then swap in the real ATEM.

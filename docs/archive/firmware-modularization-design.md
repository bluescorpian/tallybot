# Firmware modularization — design

**Date:** 2026-06-10
**Status:** implemented — both PlatformIO envs compile clean; pending on-hardware re-verification

## Problem

`firmware/src/main.cpp` has grown to 1,278 lines — one translation unit holding the
LED state machine, WiFi connection lifecycle, the SoftAP diagnostics panel, the USB-CDC
control channel, UDP discovery, the TCP tally client, message dispatch, and the
`setup()`/`loop()` orchestrator. Roughly 40% of the file is comment prose. It is hard to
hold in context, hard to change without touching unrelated concerns, and carries
hardware workarounds that don't apply to this board.

## Goals

- Split the monolith into focused, independently-readable modules with small typed APIs.
- Cut comment volume hard — the code should be self-documenting; comments earn their place
  only where intent isn't obvious from the code.
- Remove hardware-misattributed workarounds and dead protocol scaffolding.
- Behavior need not stay 1:1; documented features are preserved unless explicitly trimmed
  below.

## Non-goals

- No change to the wire protocol. `protocol.h` is the synced C++ mirror of
  `app/sidecar/src/protocol.ts` and `app/src-tauri/src/usb/protocol.rs`; it stays untouched.
- No new features.

## Constraints (do not regress these)

- **Full TX power, never capped** — start and stay at `WIFI_POWER_19_5dBm`.
- **`Serial.setTxTimeoutMs(0)`** — mandatory, or CDC TX stalls the render loop (arduino-esp32 #7779).
- Two PlatformIO envs stay valid: dev (`TALLYBOT_USB_TEXT_LOG`, plain Serial) and release (COBS-framed logs).

## Module decomposition

`protocol.h` stays as-is. Everything in `main.cpp` splits into:

| File | Scope | Depends on |
|------|-------|-----------|
| `led.h/.cpp` | LED state machine: resting colour + motion, IDENTIFY flash, boot self-test, brightness/gamma math, dirty-checked `FastLED.show()`. | FastLED |
| `settings.h/.cpp` | NVS-backed device settings: transport mode + cached SSID. Typed get/set. | Preferences |
| `log.h` | `TLOG(level, fmt, …)` — the one logging seam. Dev = plain Serial; release = COBS LOG frame (calls a `usb` function declared here, defined in `usb.cpp`). No circular include. | usb (decl only) |
| `wifi.h/.cpp` | Connection lifecycle: country/channel setup, full-power connect + captive-portal fallback, reprovision, non-blocking association, `currentWifiState()`, trimmed diagnostics panel HTML, disconnect-reason capture. | settings, led, log |
| `usb.h/.cpp` | USB-CDC COBS channel: framed send, HELLO re-announce, STATUS emit + change-detect, RX pump, packet handler → dispatch callback. | protocol, log |
| `tally.h/.cpp` | Tally client: UDP discovery + TCP connect/heartbeat + connection state machine. | protocol, led, log |
| `control.h/.cpp` | Message dispatch (`applyServerMessage`): routes a decoded command to led / wifi / usb / settings. Shared by both transports (TCP + USB). | led, wifi, usb, settings |
| `main.cpp` | `setup()` + `loop()` orchestrator: init order, the top-level cable-state decision, per-tick service calls. | all |

Each `.cpp` keeps its statics private; headers expose only the small API the orchestrator
and peers need. Cross-module integration (decoded-message routing) lives solely in `control`.

## Simplifications (behavior changes)

1. **Remove the TX-power ladder entirely.** The low-power fallback (`WIFI_POWER_8_5dBm`,
   `TXPOL_*`, `loadTxPolicy/saveTxPolicy`, `applyTxPower`, `reasonSawAp`, the low-power retry)
   targets a weak-antenna board variant that isn't this hardware. The radio runs at full power
   always. `connectWithTxPolicy()` collapses to: full power → `autoConnect` → captive portal on
   failure. **Doc impact:** revise CLAUDE.md gotcha #3 to "start and stay at full power, never
   cap unconditionally" (drop the fallback clause).

2. **Trim the SoftAP diagnostics panel.** Keep a one-line plain-English verdict (wrong-password
   vs out-of-range vs got-kicked, derived from the last disconnect reason), the stored SSID,
   the stored password *length*, firmware build, and MAC. **Cut:** the persisted-across-reboot
   failure store (`saveDiag/loadDiag` and the `dr/drr/drssi/dssid/dassoc` NVS keys) and the
   "keep most-diagnostic reason" reason-8 clobber-filtering (`associatedSinceConnect`,
   `attemptHasDiag`). We record only the last raw disconnect reason + whether we'd associated,
   live. **Doc impact:** `docs/wifi-troubleshooting.md` references the panel — note that the
   verdict no longer survives the reboot that raises the portal.

3. **Collapse the USB-first-boot state** to a single `enum CableState { DECIDING, USB_OWNED, WIFI }`
   replacing the `wifiBringupPending` + `usbSession` + interlocking-flag dance. Same observable
   behavior: plugged-in WiFi-mode device waits a grace window for a host HELLO reply (USB wins →
   `USB_OWNED`, radio kept warm via background association), else starts the WiFi bring-up
   (→ `WIFI`); a live USB-host loss reverts `USB_OWNED` → `WIFI`.

4. **Simplify STATUS change-detection** to a plain "snapshot changed?" struct compare, and fold
   the `WIFI_STATE_FAILED` debounce into one timer check.

5. **Drop dead firmware scaffolding** for reserved protocol messages (`MSG_SCAN_RESULT`,
   `MSG_SCAN_WIFI`, `MSG_RELAY`) — they remain defined in `protocol.h` but carry no firmware code.

## Open item (decide at spec review)

- **2.4 GHz channel widening to 1–13 (`esp_wifi_set_country`, hardcoded "ZA").** Not a hardware
  band-aid — it makes channels 12/13 usable for venues whose AP sits there. Recommendation:
  **keep**. Region is hardcoded; flag if it should go.

## Preserved behavior (explicitly not changed)

Boot self-test, captive-portal provisioning, BOOT-button reprovision, UDP discovery, TCP
HELLO/HEARTBEAT/SET_COLOR/IDENTIFY, the full LED palette + motions, save-only USB WiFi
provisioning, transport-mode (WiFi / No-TX) persistence, live STATUS streaming, USB-first boot
and unplug-revert, the bounded `while(!Serial)` enumerate wait.

## File handling

Existing files are moved aside, not edited in place: `src/main.cpp` → `src/main.cpp.old`
(and removed once the new build is verified). `protocol.h` stays. New module files are added
under `src/`.

## Verification

- `pio run -e esp32-c3-devkitm-1` and `pio run -e esp32-c3-release` both compile clean.
- On-hardware smoke (user-run): boot self-test, captive portal, discovery + SET_COLOR over TCP,
  USB detect + SET_COLOR + unplug-revert.

## Doc updates to land with the change

- CLAUDE.md gotcha #3 (TX power) and component-status firmware bullet.
- `docs/wifi-troubleshooting.md` (diagnostics panel no longer persists across reboot).
- `firmware/README.md` if it describes file layout.

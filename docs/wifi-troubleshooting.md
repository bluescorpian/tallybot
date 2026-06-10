# WiFi-join troubleshooting — living runbook

A working document for getting the ESP32-C3 tally lights reliably onto **venue WiFi**. This is
the **deferred** problem: the project pivoted to the [ESP-NOW transport](milestones/roadmap.md)
(item 3) for near-term venue reliability, but WiFi-join is wanted "one day" as a first-class
transport. Pick up here when returning to it.

- **Historical record** of the venue tests (full ranked-cause analysis): [`archive/field-test-venue-1.md`](archive/field-test-venue-1.md).
- **Closed milestone** that shipped the firmware hardening: [`milestones/v1.1-production-hardening.md`](milestones/v1.1-production-hardening.md).
- **Firmware** that produces the diagnostics: [`../firmware/src/wifi.cpp`](../firmware/src/wifi.cpp)
  (`onDisconnected`, `onConnected`, `buildDiagHtml`, `verdict`, `connectBlocking`). The panel is now
  **live-only** — the last-failure verdict is captured in RAM and shown on the portal, but no longer
  persisted across the reboot that raises the portal.

---

## Current status

**Blocked on venue access-point policy, not on the firmware.** The firmware hardening has
shipped and is bench-verified; the remaining failure mode is the AP turning a weak client away,
which the device can't fix on its own. The on-device diagnostics now make the *next* venue visit
conclusive rather than blind.

## How to read the SoftAP diagnostics panel

When a device can't join, it raises its `TallyLight-XXXXXX` SoftAP. Join it with a phone and the
landing page shows a **diagnostics panel**. The decisive line is the **verdict**, which turns on
whether the device *associated* (completed the 4-way handshake) before failing:

- **"Joined, then the AP dropped us"** (`associated = yes`) → **not** a password problem; the
  password and signal were good enough to associate. This is a genuine AP **kick** — almost
  always a **minimum-RSSI cutoff** or **band-steering** on a managed AP. *The fix is operational,
  not firmware:* get the device closer to an AP, add antenna, or use a different SSID.
- **"Failed before joining"** (`associated = no`) → read the reason:
  - auth/handshake (2 / 15 / 202 / 204) → wrong password or WPA-mode mismatch.
  - not-found / beacon (200 / 201) → out of range, a 5GHz-only SSID (the C3 is 2.4GHz only), or
    an SSID typo.
  - leave/deauth (3 / 8) → the AP refused us before association (MAC filter, min-RSSI, steering).

The panel also shows the **raw** last reason next to the kept one — if they differ, our own
teardown disconnect was suppressed in favour of the real failure (see [Gotcha: reason 8](#gotcha-reason-8-is-ambiguous)).

## What's been ruled out

- **Password special-char truncation (the `#` theory)** — *ruled out at venue 2.* The panel
  showed a stored-password length of 12 (full length); a truncated `#` would read short.
- **Channels 12/13 unreachable** — *addressed.* `esp_wifi_set_country()` sets a manual 1–13 range
  (the validated `esp_wifi_set_country_code("ZA")` path rejects "ZA").

## Current best hypothesis (venue 2)

A **managed AP** (UniFi / Aruba / Meraki-class) enforcing a **minimum-RSSI** threshold and/or
**band-steering**, turning away the tally light at **−79 dBm** on 2.4GHz. Reason **8**
(`ASSOC_LEAVE`) at that signal level fits a post-association deauth kick. Confirm at the next
visit with the verdict line (expected: *joined-then-dropped*).

## Gotcha: reason 8 is ambiguous

`WIFI_REASON_ASSOC_LEAVE` (8) is emitted **both** when the AP kicks us **and** when *we*
disconnect (our `setCleanConnect` + portal teardown). The firmware now keeps the most-diagnostic
reason and tracks association so the verdict disambiguates — but when reading raw serial logs,
don't take a trailing reason-8 at face value; look for the *earlier* substantive code and whether
a `STA_CONNECTED` event fired.

## What to try next (when revisiting)

1. **Capture full serial at the venue.** Now that a laptop can be attached, log the whole
   sequence — the reason codes in order and whether `STA_CONNECTED` fires — to settle
   joined-vs-kicked beyond the one-line verdict.
2. **If "joined then dropped":** it's AP policy. Options: move the device within ~−65 dBm of an
   AP; confirm/adjust min-RSSI + band-steering + fast-roaming (802.11r) on the AP if it's under
   our control; test an external-antenna C3 variant.
3. **If "never joined":** chase the specific reason code (auth → creds/WPA mode; not-found →
   band/range/SSID).
4. **Firmware experiments worth trying** (none attempted yet): PMF (protected management frames)
   mode, a longer listen interval, disabling 11b-only rates, pinning a BSSID, or an explicit scan
   method — all candidates if a managed AP keeps kicking a correctly-credentialed client.

## Reference: reason codes

`wifi_err_reason_t` (the ones the panel decodes): 2 auth-expired · 3 auth-leave · 4 assoc-expired
· 8 assoc-leave (deauth / our own disconnect) · 15 wrong password / 4-way handshake timeout · 200
beacon timeout · 201 AP not found · 202 auth fail · 203 assoc fail · 204 handshake timeout · 205
connection fail.

# Field-Test Findings — Venue Test, June 2026

Notes and remediation plan from the second on-site test. The app side went well: the
Tauri app launched, scanned, and picked up the ATEM Mini. The problems were all on the
**device/network edge** — getting the ESP32-C3 tally lights onto the venue WiFi, having
*no visibility* into why they failed, and **ambiguous LED states** during bring-up.

This is a **planning document**: each section is one issue — what happened, the likely
causes (ranked), and a concrete plan to close them.
Status legend: `[ ]` todo · `[~]` proposed/needs sign-off.

Related: [`ARCHITECTURE.md`](ARCHITECTURE.md) (protocol + failure signalling),
[`firmware/src/main.cpp`](firmware/src/main.cpp) (the state machine),
[`LED.md`](LED.md) (the LED palette that comes out of Issue 3).

### Implementation status — firmware (June 2026, bench-verified)

The **firmware-side** fixes have landed and are confirmed on an ESP32-C3:
- **Issue 1:** TX power now full-first with a conditional low-power fallback (only retried when
  the AP was actually seen, so a `NO_AP_FOUND` goes straight to the portal — time-to-portal
  cut from ~94 s to ~20 s); WiFi country forced to a manual 1–13 channel range via
  `esp_wifi_set_country()` (the validated `esp_wifi_set_country_code("ZA")` path rejects "ZA");
  shorter connect timeout/retries.
- **Issue 2:** WiFi disconnect reason captured + decoded, persisted to NVS, and shown on a
  **SoftAP captive-portal diagnostics panel** (reason / SSID tried / stored-password length /
  RSSI / MAC) — the "serial monitor over the phone."
- **Issue 3:** the device-local LED palette with motion, at 10% local brightness (cyan
  "searching" is a smooth pulse, not a blink).
- **Plus:** hold the **BOOT button ~3 s** to re-open the WiFi portal and switch networks
  without erasing creds.

Still **out of scope / needs the sidecar** (tracked below): bring-your-own-AP user guidance,
the in-app logs panel, the device→server diagnostic frame, and the server-driven LED states
(live/preview/idle/fault + the server `SETUP_COLOR` magenta→white change).

---

## Issue 1 — ESP32-C3 sees the WiFi but won't join (then drops back to SoftAP)

### What happened

The devices listed the venue SSID with **strong signal**, but on connect they would
**attempt → fail → re-raise the SoftAP** (`TallyLight-XXXXXX`) captive portal with an
error. Repeatable. Suspected the band or the password (it contains `#`).

### Why "strong signal but can't join" is the key clue

The signal bars in the scan list are **receive** strength (AP → device, downlink). They
say nothing about whether the device's **transmit** reaches the AP, or whether
**authentication / DHCP** succeed. Every likely cause below produces exactly this
symptom: a strong scan entry that nonetheless fails to associate or to get an IP.

### Likely causes, ranked

**1. We cripple TX power on *every* board (most likely, and fully in our control).**
`firmware/src/main.cpp:244` unconditionally calls
`WiFi.setTxPower(WIFI_POWER_8_5dBm)`. The C3's normal max is ~20 dBm, so this runs the
radio **~11 dB down (~12× less power)**. It was meant as a *fallback* for old boards
whose antenna won't otherwise associate — but applied to all boards it slashes uplink
range. At a venue the AP is typically far away: the device hears the AP fine (downlink),
but its weak uplink can't complete the association/4-way handshake → fail → SoftAP. This
matches the symptom precisely.
→ **Fix:** start at **full power** and only drop to 8.5 dBm as a *retry* fallback after a
failed attempt — not as the default. (Action items below.)

**2. The venue network is something WiFiManager structurally cannot join.** Many venue /
hotel / corporate networks are:
- **WPA2/WPA3-Enterprise (802.1X)** — needs a username + identity + maybe a certificate.
  WiFiManager only does PSK. The SSID shows in the scan but is un-joinable by us.
- **A browser/captive sign-in** ("click to accept", room number, etc.). The ESP joins the
  radio but the network blocks all traffic until a human signs in via a browser — which
  the ESP can't do. Looks like a DHCP/connect failure.
- **AP/client isolation** — joins and gets an IP, but the AP blocks device↔device traffic,
  so the sidecar is unreachable even though WiFi "worked."
→ **Fix (operational, see Issue 1.5):** **bring your own 2.4 GHz AP.** This is the single
most reliable change and the design already assumes you control the subnet.

**3. Channel 12/13 + country code.** Since ESP-IDF v5 the default country is `"01"`
(world-safe), which **active-scans only channels 1–11** and is cautious on 12/13. If the
venue AP sits on channel 12 or 13 (common in EU to dodge congestion), the device may see
it via passive scan yet refuse/struggle to associate.
→ **Fix:** set an explicit country (or `WIFI_COUNTRY_POLICY_MANUAL`) so 12/13 are allowed;
and on our own AP, pin channel **1/6/11**.

**4. Special characters in the password (the `#`).** Known WiFiManager class of bugs
(tzapu/WiFiManager #804): the portal passes the password through HTML form + URL handling,
where `#` (URL fragment), `&`, `+`, `%`, and spaces can be mangled/truncated before they
reach `WiFi.begin()`. The device then tries a *wrong* password → auth fail → SoftAP.
→ **Fix:** confirm/patch the portal's URL-decoding on current WiFiManager; surface the
exact auth-fail reason (Issue 2) so we can tell this apart from range; and, short-term,
avoid `# & + %` in the network password we provision against.

**5. WPA3 / PMF transition-mode quirks.** The C3 supports WPA3-SAE + PMF, but
WPA2/WPA3-**transition** APs and PMF-*required* APs occasionally fail to associate on
Arduino-ESP32 depending on the core version.
→ **Fix:** keep arduino-esp32 / WiFiManager current; confirm WPA3-SAE is enabled in the
build; treat as a candidate only after 1–4 are ruled out.

**6. Connect timeout too short under venue RF load / SoftAP-on-C3 quirks.** A congested
venue band slows association + DHCP; WiFiManager's default connect window can expire and
bounce to the portal. There are also documented C3-specific SoftAP/STA toggle bugs on
older cores.
→ **Fix:** raise connect timeout + retries; pin to a current core.

### Plan / action items

- [ ] **TX power: full power by default, low only as a fallback.** Remove the unconditional
  8.5 dBm. Attempt 1 at max power; if association fails, retry at `WIFI_POWER_8_5dBm`
  before giving up. Log which power level finally worked.
- [~] **Bring-your-own AP as the recommended deployment** (see Issue 1.5) — a dedicated
  2.4 GHz WPA2-PSK SSID, simple password (no `# & + %`), channel 1/6/11, no client
  isolation, no enterprise/sign-in. Document in the user guide.
- [ ] **Set WiFi country / channel policy** so channels 12–13 are usable; document the
  1/6/11 recommendation for our own AP.
- [ ] **Harden password handling** on the captive portal: verify current WiFiManager
  URL-decodes `# & + % space` correctly; add a confirmation echo of the parsed SSID/length
  on the portal so a mangled password is visible before saving.
- [ ] **Increase connect timeout + retries** (`setConnectTimeout`, `setConnectRetries`),
  and confirm arduino-esp32 / WiFiManager are on current, known-good versions.
- [ ] **Confirm WPA3-SAE enabled** in the build; note PMF behaviour.
- [ ] After the above, re-test against (a) our own AP and (b) the venue SSID, capturing the
  failure reason from Issue 2 each time.

### Issue 1.5 — Recommended fix: bring your own access point

TallyBot is **explicitly designed for a single subnet you control** (`CLAUDE.md`,
`ARCHITECTURE.md`). The most robust venue setup is therefore to **not** rely on the venue
WiFi at all:

- A small **travel router** or a **phone/MiFi hotspot** running **2.4 GHz**, **WPA2-PSK**,
  a **simple password**, channel **1/6/11**, **AP isolation off**.
- Put the streaming PC (running TallyBot) and all tally lights on it.
- This sidesteps causes 2–6 wholesale: no enterprise auth, no browser sign-in, no band
  steering, no exotic channel, no client isolation, no congestion.

This should be presented to users as the **recommended** topology, with "join an existing
network" as the fallback once the firmware fixes above land. (It does **not** replace the
firmware fixes — we still want the devices robust on arbitrary 2.4 GHz PSK networks.)

---

## Issue 2 — No visibility into what the firmware was doing

### What happened

On the streaming PC there was only the TallyBot app — **no serial monitor**. When the
devices failed to join WiFi, there was no way to see *why* (wrong password? out of range?
no DHCP? channel?). Debugging blind at a venue is untenable.

### The core constraint

A WiFi-join failure happens **before** the device has any network path off itself — no
TCP to the sidecar, no UDP off the box. So that class of failure can **only** be surfaced
**on the device** or **through its own SoftAP**, not through the app. Two visibility
layers are needed:

**A. Pre-connection visibility (for WiFi-join failures) — on-device + via the SoftAP.**
- **Capture and display the WiFi failure reason.** Subscribe to `WiFi.onEvent` /
  read the disconnect reason code, and classify it: *wrong password / auth fail* vs
  *AP not found* vs *no IP (DHCP)* vs *association timeout*. This alone would have answered
  "was it the `#` or the range?" on the spot.
- **Show it on the captive portal page.** The operator already joins the device's SoftAP
  with a phone — turn that page into a mini "serial monitor": last failure reason, last
  SSID tried, RSSI seen, firmware version, MAC. Persist the last-boot reason to NVS so it
  survives the reboot and shows on the next portal. This is the **phone-as-serial-monitor**
  fix and needs no PC.
- **Distinct LED states for each failure/bring-up phase** (Issue 3) — the zero-infra
  first signal.

**B. Connected-phase visibility (for everything after TCP is up) — in the app.**
- **A log/console panel in the TallyBot UI.** The sidecar already streams NDJSON to the
  app; surface a logs view. Then add a device→server **diagnostic/log message** so a
  connected device can report events (reconnects, RSSI drops) into that panel.
- **Per-device health in the UI.** Extend `HELLO`/`HEARTBEAT` (or a new diag frame) to
  carry **RSSI, IP, uptime, reconnect count, firmware version**, shown per device on the
  board. Turns "is it healthy?" into a glance. (Protocol is length-prefixed and
  forward-compatible — extra trailing fields are skippable by old parsers, so this is an
  additive change; keep `protocol.ts` and `protocol.h` in lockstep.)

### Plan / action items

- [ ] **Capture WiFi disconnect reason codes** in firmware and classify them
  (auth-fail / not-found / DHCP / timeout).
- [~] **Diagnostics page on the SoftAP captive portal**: last failure reason (from NVS),
  SSID tried, RSSI, FW version, MAC — the "serial monitor over the portal."
- [ ] **Persist last-boot diagnostics to NVS** so a failure is readable after the reboot.
- [~] **In-app logs panel** fed by the sidecar's existing NDJSON stream.
- [~] **Device→server diagnostic frame** (additive protocol message) so connected devices
  log into the app; carry RSSI/IP/uptime/reconnects/FW version for per-device health.
- [ ] *(Optional, stretch)* a tiny live-log page served on the SoftAP, not just last-error.

---

## Issue 3 — LED states are ambiguous (colours are shared across phases)

### What happened

During bring-up it was **not clear** whether a device was in the pre-connection phase, the
looking-for-TallyBot phase, or the connected-but-unassigned phase. They share colours, so
you can't read the device's state from across the room. Goal: **every bring-up phase gets a
unique colour, with no sharing**, documented in **`LED.md`**.

### Where the sharing is today (from the code)

- **Magenta is used for two unrelated states.** Firmware `COLOR_SETUP` (255,0,255) is the
  **captive portal** hint (`main.cpp:189,216`), while the sidecar **also** sends magenta as
  `SETUP_COLOR` for a **connected-but-unassigned** device (`app/sidecar/src/protocol.ts:81`,
  `engine.ts:121`). So "I need WiFi setup" and "I'm online but unassigned" look **identical**.
  *(The `protocol.ts` comment even flags the setup colour as provisional / not yet decided.)*
- **Steady blue is overloaded.** `COLOR_DISCONNECTED` (0,0,255) covers *WiFi connecting*,
  *discovering the server*, *TCP connecting*, the *gap after connect before the first
  SET_COLOR*, *WiFi lost*, and *server lost* — six distinct situations on one colour
  (`main.cpp:180,203,241,328`). "Still searching, never connected" and "was connected, just
  dropped" are very different operator messages shown identically.
- **The two *disconnect* causes look the same but need opposite fixes.** Blue is shown both
  when the device **loses WiFi** (`handleWifiDown`, `main.cpp:203`) and when it **loses the
  TallyBot server** while WiFi is fine (`main.cpp:328`). These are different diagnoses:
  - *Lost WiFi* → the **network** is the problem (AP down, out of range, venue WiFi flaked).
    Go look at the access point / move the device closer.
  - *Lost the server* → the **WiFi is fine but the sidecar/PC/app** is the problem (TallyBot
    app closed, streaming PC asleep, sidecar crashed). Go look at the computer.
  Showing one colour for both sends the operator to the wrong place. They must be distinct.

This is the root of the confusion, and it's structural, not just perceptual.

### Proposed palette (full spec in [`LED.md`](LED.md))

Give each bring-up phase a unique hue, and use *motion* (steady / pulse / blink / flash) as
a second, meaningful axis. Reserve the existing tally colours (red/green/dim-white) and the
two-blues fault model untouched. Summary of the change:

| Phase | Today | Proposed |
|---|---|---|
| Boot self-test | — | **R→G→B→W ~1s sweep** (new) |
| Captive portal / provisioning (no WiFi) | Magenta steady | **Magenta steady** (keep) |
| Joining WiFi (first assoc. to saved AP) | Steady blue | **Amber, pulsing** |
| **Lost WiFi** (had it, AP/range gone — *network problem*) | Steady blue | **Amber, fast blink** |
| Searching for TallyBot (WiFi up: discovery + TCP) | Steady blue | **Cyan, smooth pulse** |
| Connected, **unassigned** | Magenta (server) | **White, slow breathe ~10s** *(new `SETUP_COLOR`)* |
| **Lost the TallyBot server** (WiFi fine — *PC/app problem*) | Steady blue | **Steady blue** (keep — now means *only* this) |
| Live / Preview / Idle (assigned) | Red / Green / Dim-white | unchanged |
| Fault (assigned, source untrusted) | Flashing blue | unchanged |
| IDENTIFY | White flash burst | unchanged |

Decisions locked with the user (June 2026): unassigned = **white slow breathe** (kept apart
from idle dim-white and IDENTIFY flash by brightness + motion); **amber = WiFi family / blue =
server-side**; **boot self-test = yes**. Full spec + remaining implementation note in
[`LED.md`](LED.md).

Net effect: magenta means *only* "set me up over my SoftAP"; yellow means *only* "online,
needs assigning"; cyan means *only* "looking for the server"; **amber means *only* a WiFi
problem** (go check the network/AP); **steady blue now means *only* "WiFi is fine but I lost
the TallyBot server"** (go check the PC/app). The two disconnect causes finally read
differently, and no colour carries two meanings.

The amber family ties together by diagnosis — *anything WiFi-side* is amber (first join =
pulsing, lost-and-reconnecting = fast blink) — while blue is reserved for *server-side*
trouble. So a glance tells the operator **which box to go look at**.

### Cross-component changes this implies (so the spec stays coherent)

- Firmware: split the single `COLOR_DISCONNECTED` usage into the per-phase colours above;
  during the post-connect gap, show the **unassigned** colour locally (no blue flash) so it
  matches what the server will send.
- Sidecar: change `SETUP_COLOR` (`protocol.ts`) from magenta → the chosen **unassigned**
  colour; keep `protocol.h` in lockstep.
- Docs: update the colour table in `ARCHITECTURE.md` ("Standard Colours") and any UI colour
  legend in `DESIGN.md`; `LED.md` becomes the source of truth and the others link to it.

### Remaining open item (one, post-sign-off)

- [~] **How the server signals "unassigned"** without a protocol change, so the device can
  render the white breathe locally (the wire `SET_COLOR` is static and can't carry an
  animation). Default plan: the device animates when it sees the unassigned colour; the
  connect-gap breathe is purely device-local. Exact RGB + breathe/blink periods to be tuned
  on hardware. (Cyan-vs-blue and amber-vs-white separation confirmed acceptable.)

### Plan / action items

- [x] Palette agreed with the user (June 2026) — see locked decisions above.
- [x] **`LED.md`** drafted as the source of truth.
- [ ] Firmware: implement the per-phase colours + motion; remove blue overloading.
- [ ] Sidecar: change `SETUP_COLOR`; keep `protocol.h`/`protocol.ts` synced.
- [ ] Update `ARCHITECTURE.md` colour table + `DESIGN.md` legend to point at `LED.md`.

---

## Suggested order of work next session

1. **Issue 1 firmware TX-power fix** + **Issue 2 failure-reason capture** — cheap, high
   payoff, and together they'd have explained the venue failure on the spot.
2. **Issue 3 LED palette** — finalise `LED.md`, then implement firmware + sidecar together.
3. **Issue 2 visibility** — SoftAP diagnostics page, then the in-app logs panel.
4. **Issue 1.5** — write the "bring your own AP" deployment guidance for users.
5. Re-test: first on our own AP (should be clean), then against the venue SSID with the new
   failure-reason readout to confirm which cause it actually was.

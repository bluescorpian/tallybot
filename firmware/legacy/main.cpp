// TallyBot firmware — the tally-light client for the ESP32-C3 SuperMini.
//
// On the wire this is a TCP *client* (ARCHITECTURE.md): it provisions WiFi via a
// captive portal, discovers the sidecar over UDP broadcast, opens a TCP connection,
// sends HELLO then HEARTBEATs, and drives the onboard WS2812 LED from the server's
// SET_COLOR / IDENTIFY commands. The binary wire format lives in `protocol.h` (the
// C++ mirror of `app/sidecar/src/protocol.ts`).
//
// It can be developed and tested with no ATEM and no app, against the standalone
// sidecar dev runner (`tools/`, `pnpm sidecar-dev`), which binds TCP 7000 / UDP 7001.
//
// Board gotchas this firmware respects (CLAUDE.md / ARCHITECTURE.md):
//   * GPIO8 is an addressable WS2812, not a digital pin — driven via FastLED only.
//   * Never sleep: the loop stays busy (no deep/light sleep) so a USB power bank's
//     auto-off can't cut power on low current. WiFi stays active throughout.
//   * Serial reaches USB only with the ARDUINO_USB_CDC_ON_BOOT flag (platformio.ini).
//
// LED meaning — the device-local bring-up states (full spec in ../../LED.md). Each phase
// gets a unique hue + motion so the operator can read the device across the room, and the
// first read tells them which box to check: amber = WiFi/network, blue = the TallyBot PC.
//   * Boot self-test ..... R→G→B→W sweep at power-on — proves the LED works.
//   * Magenta (steady) ... captive portal up — join the TallyLight-XXXXXX AP.
//   * Amber (pulse) ...... joining WiFi (associating with the saved AP).
//   * Amber (fast blink) . had WiFi, lost it — a NETWORK problem (check the AP / range).
//   * Cyan (smooth pulse) WiFi up, hunting for the TallyBot server (never connected yet).
//   * White (breathe) .... connected but unassigned (brief, until the first SET_COLOR).
//   * Blue (steady) ...... had the server, lost it while WiFi is fine — check the PC/app.
//   * Server colours ..... live / preview / idle / server-driven flashing fault.
//   * Brief white flash .. IDENTIFY — so the operator can locate this device.
//
// Switching WiFi networks: hold the on-board BOOT button (~3s) at any time to re-open the
// captive portal without erasing the current creds — the LED turns magenta when it fires.

#include <Arduino.h>
#include <FastLED.h>
#include <PacketSerial.h>  // bakercp/PacketSerial — COBS framing over USB-CDC (v1.2)
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiManager.h>  // tzapu/WiFiManager — SoftAP captive portal + NVS creds
#include <WiFiUdp.h>
#include <stdarg.h>
#include <esp_wifi.h>  // esp_wifi_set_country — widen the usable 2.4GHz channel set

#include "protocol.h"

// ── LED ──────────────────────────────────────────────────────────────────────
#define LED_PIN 8
#define NUM_LEDS 1

// ── Controls ─────────────────────────────────────────────────────────────────
// The SuperMini's on-board BOOT button (active-low). It's a boot-strapping pin, but we only
// read it at *runtime* — holding it for REPROVISION_HOLD_MS re-opens the WiFi captive portal
// so you can switch networks without erasing the current creds (cancel keeps the old network).
#define BOOT_BUTTON_PIN 9
#define REPROVISION_HOLD_MS 3000

// Device-local indicator colours (R,G,B). These are *not* wire-protocol colours — the
// firmware chooses them on its own — so they live here, not in protocol.h (which mirrors
// protocol.ts). See ../../LED.md for the full palette and rationale.
#define COLOR_JOINING 255, 120, 0   // amber: associating with / lost the WiFi AP
#define COLOR_SEARCHING 0, 255, 255  // cyan: WiFi up, hunting for the TallyBot server
#define COLOR_UNASSIGNED 255, 255, 255  // white: connected but not yet assigned an input

// ── Tunables (device-local policy, not part of the wire protocol) ────────────
#define TCP_CONNECT_TIMEOUT_MS 3000  // cap the one tolerated blocking call
#define BACKOFF_MS 2000              // wait before re-discovering after a TCP drop
#define WIFI_LOST_PORTAL_MS 60000    // sustained WiFi loss before re-arming the AP
#define IDENTIFY_TOGGLE_MS 150       // IDENTIFY flash half-period
#define IDENTIFY_TOGGLES 6           // total toggles (~0.9s of white/colour blinking)
#define BRIGHTNESS_GAMMA 2.5f        // perceptual brightness byte → LED drive (see below)

// USB-CDC control channel (v1.2). The shell owns the port; these govern the device side.
#define USB_HELLO_INTERVAL_MS 1000   // re-announce HELLO until the host sends its first frame
#define USB_TALLY_IDLE_MS 5000       // USB silence after which we release USB tally ownership
// USB-first boot: a WiFi-mode device gives USB a chance to claim it before starting the
// (blocking) WiFi bring-up — "while plugged in, all devices communicate over USB, regardless of
// provisioned mode." We wait this long for a host *reply* to our HELLO; if none arrives we assume
// there's no PC (deployed / on a power bank) and start the real WiFi join. This is sized for the
// host's worst-case latency, not ours: the app must notice the new serial port, read HELLO, and
// round-trip a frame back. HELLO goes out every second (USB_HELLO_INTERVAL_MS); the window only
// delays a genuinely host-less device's WiFi start, never HELLO emission, so we keep it generous.
#define USB_BOOT_GRACE_MS 4000

// WiFi connection policy (the venue-failure mitigations — see ../../FIELD-TEST-FINDINGS.md).
#define WIFI_COUNTRY "ZA"            // South Africa: 2.4GHz channels 1–13 (the widest legal set here)
#define WIFI_CONNECT_TIMEOUT_S 10    // per-attempt connect window; enough for association + DHCP
#define WIFI_CONNECT_RETRIES 2       // attempts per autoConnect pass (clamped 1–10 by the lib)

// USB STATUS streaming (v1.2): STATUS is pushed on change while a host is cabled, not just on
// request. The throttle bounds how often we re-check; RSSI must move past a threshold to count as
// a change (so signal jitter doesn't spam frames). FAILED is reported only once a join has failed
// for this long — comfortably past the ESP32-C3 spurious first-disconnect transient on a *correct*
// password (see applyWifiCreds), so a good password is never flashed as a failure.
#define STATUS_EMIT_INTERVAL_MS 500  // change-detector tick while a USB host is listening
#define STATUS_RSSI_DELTA_DBM 5      // RSSI move (dBm) that counts as a reportable change
#define WIFI_JOIN_FAIL_MS 12000      // settle window before a stuck join is reported as FAILED

// LED motion timing (ms).
#define PULSE_PERIOD_MS 1500   // SLOW_PULSE full cycle (joining WiFi, searching for the server)
#define BREATHE_PERIOD_MS 10000  // BREATHE full cycle (unassigned) — slow, calm
#define FAST_BLINK_MS 200      // FAST_BLINK half-period (lost WiFi)
#define BOOT_TEST_STEP_MS 250  // each colour in the power-on self-test

// Firmware build stamp, shown on the SoftAP diagnostics panel. The real wall-clock build time
// is injected by inject_build_time.py (the toolchain pins __DATE__/__TIME__ to 1980 — see that
// script); fall back to the compiler macros if the script somehow didn't run.
#ifndef BUILD_TIMESTAMP
#define BUILD_TIMESTAMP __DATE__ " " __TIME__
#endif
#define FW_BUILD BUILD_TIMESTAMP

// ── Top-level state machine ──────────────────────────────────────────────────
enum State {
  ST_PROVISIONING,  // captive portal / initial autoConnect (blocking, off tally duty)
  ST_DISCOVERING,   // WiFi up; broadcasting TALLY_FIND until the server answers
  ST_CONNECTING,    // opening the TCP connection to the discovered server
  ST_CONNECTED,     // HELLO sent; heartbeating; rendering server colours
  ST_BACKOFF,       // TCP dropped; brief wait before re-discovering
};

static State state = ST_PROVISIONING;

// Whether this device has ever reached the TallyBot server in this power cycle. It splits
// the device-local "no server" signal: before the first connect it's a normal first hunt
// (cyan, searching); after a drop it's a real fault to flag (blue, "lost the server").
static bool everHadServer = false;

// LED motion patterns layered under the (unchanged) IDENTIFY flash. Brightness is computed
// per-tick from millis(); hue stays constant for the state.
enum Motion {
  STEADY,      // constant
  SLOW_PULSE,  // gentle in/out — "working on it" (joining WiFi, searching for the server)
  FAST_BLINK,  // sharp on/off — "lost something, retrying" (lost WiFi)
  BREATHE,     // slow swell — "alive, waiting on you" (connected, unassigned)
};

// ── TX-power policy (persisted) ──────────────────────────────────────────────
// The radio starts at full power and only drops to the low fallback if a connect fails —
// the opposite of the old unconditional low-power default, which crippled uplink range at a
// venue (strong downlink in the scan, too-weak uplink to associate). The level that finally
// worked is remembered in NVS and tried first next boot.
#define TXPOL_FULL 0
#define TXPOL_LOW 1

// Identity + networking
static uint8_t mac[6];
static char apSsid[24];  // "TallyLight-XXXXXX"
// The device's stored SSID, cached ONCE at boot while the radio is initialised (and refreshed on
// SET_WIFI). The diag panel and statusSsid()'s joining branch read this cache rather than
// wm.getWiFiSSID(true): WiFiManager's persistent SSID read does esp_wifi_get_config() into an
// UNINITIALISED stack struct and, unlike its password read, does NOT guard on WIFI_MODE_NULL, so it
// returns stack garbage (e.g. "0?") whenever the driver isn't initialised. A WiFi-mode device now
// keeps its radio in STA for life, but a No-TX device's radio is off — so the cache stays the safe,
// single source for the stored name.
static char provisionedSsid[33] = {0};  // ≤32-byte SSID + NUL
static WiFiManager wm;
static WiFiUDP udp;
static WiFiClient tcp;
static FrameDecoder decoder;
static IPAddress serverIp;
static uint16_t serverPort = SERVER_PORT;
static Preferences prefs;  // NVS: TX-power policy + last-failure diagnostics ("tally" namespace)

// ── USB-CDC control channel state (v1.2) ─────────────────────────────────────
static PacketSerial usbPacket;  // COBS framing bound to Serial (the native USB-CDC port)
// Transport mode (persisted, NVS "txmode") — what the device does when *unplugged*. Open
// enum (int, not bool): WIFI joins the saved AP; NOTX disables WiFi (wired-only). Room for 2=ESP-NOW.
static uint8_t transportMode = TRANSPORT_WIFI;
static bool wifiEnabled = true;  // = (transportMode == TRANSPORT_WIFI); gates the WiFi state machine
// USB session bookkeeping.
static bool hostFrameSeen = false;       // a host frame arrived → stop re-announcing HELLO
static bool usbTallyActive = false;      // app is driving tally over USB → it wins over local indicators
static unsigned long lastUsbTallyMsg = 0;
static unsigned long lastUsbHello = 0;

// USB-first boot for WiFi-mode devices. setup() does the instant, non-blocking WiFi *config* and
// starts the non-blocking warm association, but defers the BLOCKING bring-up (connectWithTxPolicy →
// captive portal) so HELLO can go out over USB first. The loop then decides: a host frame within
// USB_BOOT_GRACE_MS → USB wins (radio stays warm, tally over USB); otherwise → no PC, run the real
// WiFi join + tally client. Re-armable so a live unplug (USB host gone, still powered) brings the WiFi
// tally client up. Only ever set on a wifiEnabled device.
static bool wifiBringupPending = false;
static unsigned long bootStart = 0;  // millis() at the start of the USB-first grace window
// A USB host claimed this cabled session (won the grace window): the device runs tally over USB and
// the WiFi discovery/TCP state machine stays dormant — but the radio stays in STA and keeps its warm
// association. This (not WiFi.getMode()) is the gate, so a save-only SET_WIFI re-issuing WiFi.begin()
// can't pull the device out of its USB-owned session. Cleared on a live USB-host loss (→ revert to
// the WiFi tally client) or BOOT-reprovision.
static bool usbSession = false;

// Host-visible WiFi-join lifecycle, for the streamed STATUS wifiState. Set when an association is
// kicked off (a save-only SET_WIFI over USB, or the operational bring-up); lets currentWifiState()
// report JOINING/FAILED instead of a bare IDLE/CONNECTED. Independent of usbSession — the SET_WIFI
// association runs in the background while the device still serves tally over the cable.
static bool wifiJoinActive = false;
static unsigned long wifiJoinStart = 0;  // millis() the join began — debounces the FAILED verdict
// Snapshot of the last STATUS frame put on the wire, so maybeEmitStatus() only re-sends on a real
// change now that STATUS streams. Reset when a USB session ends so a fresh host re-syncs from zero.
static struct {
  bool valid = false;
  uint8_t transport = 0;
  uint8_t wifiState = 0;
  int8_t rssi = 0;
  char ssid[33] = {0};
} lastStatus;
static unsigned long lastStatusEmit = 0;  // throttle clock for the change-detector

// Last WiFi-disconnect diagnostics — surfaced on the SoftAP portal (the "serial monitor over
// the phone") and persisted so the failure that triggered the portal survives the reboot.
struct WifiDiag {
  uint16_t lastReason = 0;    // most-diagnostic wifi_err_reason_t (0 = none) — see onWifiEvent
  uint16_t rawReason = 0;     // last *raw* disconnect reason, unfiltered — a sanity check vs lastReason
  int8_t lastRssi = 0;        // RSSI reported with the disconnect
  char lastSsid[33] = {0};    // SSID the device was trying
  bool associated = false;    // did we reach association (STA_CONNECTED) before this failure?
  bool valid = false;
};
static WifiDiag diag;

// Did we associate (4-way handshake done → password definitely correct) in the connect episode
// that's currently failing? Set on STA_CONNECTED, cleared when we record the next disconnect, so
// each attempt is judged on its own. It splits the verdict: associated-then-dropped is a genuine
// AP kick (signal/policy), never-associated is an auth/range/band problem.
static bool associatedSinceConnect = false;
// Has the current connect episode recorded any disconnect yet? The first event of a fresh episode
// always replaces stale data (possibly from a previous boot/network); later events in the same
// episode use the "keep the most diagnostic reason" rule so our own teardown can't clobber it.
static bool attemptHasDiag = false;
static String diagHtml;  // built HTML for the portal panel; must outlive wm (it keeps the ptr)

// Timers (all rollover-safe millis() deltas)
static unsigned long lastDiscoveryBroadcast = 0;
static unsigned long lastHeartbeat = 0;
static unsigned long backoffStart = 0;
static unsigned long wifiLostSince = 0;   // 0 = WiFi believed up
static unsigned long btnDownSince = 0;    // 0 = BOOT button not currently held

// ── LED rendering ────────────────────────────────────────────────────────────
static CRGB leds[NUM_LEDS];

// The resting colour + motion (set by SET_COLOR or a device-local signal). IDENTIFY flashes
// over the top of it, then restores it. restBaseBrightness is the nominal level the motion
// modulates.
static uint8_t restR = 0, restG = 0, restB = 0, restBaseBrightness = LOCAL_BRIGHTNESS;
static Motion restMotion = STEADY;

// Last values actually pushed to the LED — a dirty-check so we only call FastLED.show()
// (which briefly disables interrupts) when something changes. Animated motions naturally
// drive show() only when the computed brightness actually steps.
static bool shownValid = false;
static uint8_t shownR = 0, shownG = 0, shownB = 0, shownBrightness = 0;

static bool identifyActive = false;
static unsigned long identifyStart = 0;

static void applyColor(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness) {
  if (shownValid && r == shownR && g == shownG && b == shownB && brightness == shownBrightness) {
    return;  // already on screen
  }
  leds[0] = CRGB(r, g, b);
  FastLED.setBrightness(brightness);
  FastLED.show();
  shownValid = true;
  shownR = r;
  shownG = g;
  shownB = b;
  shownBrightness = brightness;
}

// Map a 0–255 wave onto [loPct%..100%] of base — used by the pulse/breathe motions.
static uint8_t scaleRange(uint8_t wave, uint8_t base, uint8_t loPct) {
  uint8_t lo = (uint16_t)base * loPct / 100;
  return lo + (uint16_t)(base - lo) * wave / 255;
}

// The brightness to drive this tick for a given motion. sin8() (FastLED) gives a smooth,
// cheap sine for the pulse/breathe swells; the blinks are plain square waves.
static uint8_t computeMotionBrightness(Motion m, uint8_t base, unsigned long now) {
  switch (m) {
    case SLOW_PULSE:
      return scaleRange(sin8((uint8_t)((now % PULSE_PERIOD_MS) * 256 / PULSE_PERIOD_MS)), base, 30);
    case BREATHE:
      return scaleRange(sin8((uint8_t)((now % BREATHE_PERIOD_MS) * 256UL / BREATHE_PERIOD_MS)), base, 10);
    case FAST_BLINK:
      return ((now / FAST_BLINK_MS) & 1) ? 0 : base;
    case STEADY:
    default:
      return base;
  }
}

// Set the resting colour + motion. Shows it immediately unless an IDENTIFY flash is running
// (the flash restores the resting colour when it ends). Safe to call every loop —
// applyColor() de-dupes — and safe from a blocking WiFiManager callback.
static void setResting(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness, Motion motion = STEADY) {
  restR = r;
  restG = g;
  restB = b;
  restBaseBrightness = brightness;
  restMotion = motion;
  if (!identifyActive) applyColor(r, g, b, computeMotionBrightness(motion, brightness, millis()));
}

// A *device-local* indicator (the bring-up colours). Suppressed while a USB tally session is
// active so the app's SET_COLORs win — a USB session presents to the LED exactly like "server
// connected" (no new LED states; the wired indicator is UI-side only). Server/USB SET_COLOR
// calls setResting() directly, so they always apply.
static void setRestingLocal(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness, Motion motion = STEADY) {
  if (!usbTallyActive) setResting(r, g, b, brightness, motion);
}

static void startIdentify() {
  identifyActive = true;
  identifyStart = millis();
}

// Drive the LED for this tick: the resting colour (modulated by its motion), or the IDENTIFY
// flash if active. On IDENTIFY-end the resting frame is *recomputed* (not restored to a stale
// static level) so an animated state keeps animating afterwards.
static void renderLed(unsigned long now) {
  if (!identifyActive) {
    applyColor(restR, restG, restB, computeMotionBrightness(restMotion, restBaseBrightness, now));
    return;
  }
  unsigned long elapsed = now - identifyStart;
  unsigned long phase = elapsed / IDENTIFY_TOGGLE_MS;
  if (phase >= IDENTIFY_TOGGLES) {
    identifyActive = false;
    applyColor(restR, restG, restB, computeMotionBrightness(restMotion, restBaseBrightness, now));
    return;
  }
  if (phase % 2 == 0) {
    applyColor(255, 255, 255, DEFAULT_BRIGHTNESS);  // bright white — a locate function, stays bright
  } else {
    applyColor(restR, restG, restB, computeMotionBrightness(restMotion, restBaseBrightness, now));
  }
}

// Power-on LED check: R→G→B→W, so a dead LED/driver is obvious before anything else. Dim
// (LOCAL_BRIGHTNESS) and brief (~1s total) — bounded delays in setup are fine (no sleep).
static void bootSelfTest() {
  applyColor(255, 0, 0, LOCAL_BRIGHTNESS);
  delay(BOOT_TEST_STEP_MS);
  applyColor(0, 255, 0, LOCAL_BRIGHTNESS);
  delay(BOOT_TEST_STEP_MS);
  applyColor(0, 0, 255, LOCAL_BRIGHTNESS);
  delay(BOOT_TEST_STEP_MS);
  applyColor(255, 255, 255, LOCAL_BRIGHTNESS);
  delay(BOOT_TEST_STEP_MS);
}

// ── USB-CDC control channel (COBS via PacketSerial) ──────────────────────────
// Frame and write one payload. Non-blocking: usbBegin() sets Serial.setTxTimeoutMs(0), so a
// host that isn't reading drops bytes rather than stalling the FastLED render loop.
static void usbSendPayload(const uint8_t* payload, size_t len) { usbPacket.send(payload, len); }

#ifndef TALLYBOT_USB_TEXT_LOG
// Release builds frame log lines as COBS LOG packets — no raw text on the wire. Best-effort
// (CDC TX is non-blocking); STATUS is the reliable channel, LOG is human-readable colour.
static void usbLogf(uint8_t level, const char* fmt, ...) {
  char msg[200];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);
  if (n < 0) return;
  size_t mlen = ((size_t)n < sizeof(msg)) ? (size_t)n : sizeof(msg) - 1;
  uint8_t payload[2 + sizeof(msg)];
  size_t plen = encodeLogPayload(payload, sizeof(payload), level, msg, mlen);
  usbSendPayload(payload, plen);
}
#endif

// Unified logging. Dev builds (TALLYBOT_USB_TEXT_LOG) print plain text so `pio device monitor`
// and the exception decoder stay usable; release builds frame each line as a COBS LOG packet
// the host demuxes to its diagnostics view. printf-style; the level is the LOG_LEVEL_* byte.
#ifdef TALLYBOT_USB_TEXT_LOG
#define TLOG(level, ...) Serial.printf(__VA_ARGS__)
#else
#define TLOG(level, ...) usbLogf((level), __VA_ARGS__)
#endif

// ── Helpers ──────────────────────────────────────────────────────────────────

// Lowercase colon form, matching how the server logs a device's MAC.
static void macToStr(char* out, size_t n) {
  snprintf(out, n, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

// Decode a WiFi disconnect reason (wifi_err_reason_t) to a short operator-facing string. The
// codes that distinguish the venue hypotheses: 15/202 = wrong password, 201/200 = out of
// range / wrong band, others = association/handshake trouble.
static const char* reasonToStr(uint16_t r) {
  switch (r) {
    case 2:
      return "auth expired";
    case 4:
      return "assoc expired";
    case 8:
      return "AP deauthenticated us";
    case 15:
      return "wrong password / 4-way handshake timeout";
    case 200:
      return "beacon timeout (lost the AP)";
    case 201:
      return "AP not found (out of range / SSID typo / wrong band)";
    case 202:
      return "auth fail (wrong password)";
    case 203:
      return "assoc fail";
    case 204:
      return "handshake timeout";
    case 205:
      return "connection fail";
    default:
      return "see reason code";
  }
}

// ── NVS: TX-power policy + diagnostics ───────────────────────────────────────

static uint8_t loadTxPolicy() { return prefs.getUChar("txpol", TXPOL_FULL); }

static void saveTxPolicy(uint8_t p) {
  if (prefs.getUChar("txpol", 0xFF) != p) prefs.putUChar("txpol", p);  // write only on change
}

// Transport mode (NVS "txmode"). Stored as an int — an OPEN enum (room for 2=ESP-NOW), never a
// bool. Default WIFI so existing flashed devices keep their current behaviour after an update.
static uint8_t loadTransportMode() { return prefs.getUChar("txmode", TRANSPORT_WIFI); }

static void saveTransportMode(uint8_t m) {
  if (prefs.getUChar("txmode", 0xFF) != m) prefs.putUChar("txmode", m);  // write only on change
}

static void applyTxPower(uint8_t policy) {
  WiFi.setTxPower(policy == TXPOL_LOW ? WIFI_POWER_8_5dBm : WIFI_POWER_19_5dBm);
}

// Did we hit the narrow case the ESP32-C3 low-TX-power antenna workaround can actually help —
// the AP is on the air and authenticates us, but a full-power association glitches? That's the
// only case worth a second, slower pass at low power. We skip the retry when:
//   * 0 / 201 (NO_AP_FOUND) / 200 (beacon timeout) — the AP wasn't reachable; lower power can't
//     conjure it.
//   * 3 (AUTH_LEAVE) / 8 (ASSOC_LEAVE) — a deauth/kick (or our own teardown disconnect). If the
//     AP is kicking a weak client (min-RSSI / band-steering), dropping to 8.5dBm makes our uplink
//     *weaker* and the kick more likely — exactly the wrong move. Stay at full power → portal.
// This keeps time-to-portal short without skipping a connection low power would actually land.
static bool reasonSawAp(uint16_t r) {
  return r != 0 && r != 201 && r != 200 && r != 3 && r != 8;
}

// Persist the latest failure (only when the reason changes — bounds NVS wear during a retry
// storm) so the SoftAP panel can show it after the portal-triggering reboot.
static void saveDiag() {
  // Skip the write only when nothing meaningful changed (bounds NVS wear during a retry storm).
  if (prefs.getUShort("dr", 0xFFFF) == diag.lastReason &&
      prefs.getUShort("drr", 0xFFFF) == diag.rawReason &&
      prefs.getUChar("dassoc", 0xFF) == (uint8_t)diag.associated) {
    return;
  }
  prefs.putUShort("dr", diag.lastReason);
  prefs.putUShort("drr", diag.rawReason);
  prefs.putChar("drssi", diag.lastRssi);
  prefs.putString("dssid", diag.lastSsid);
  prefs.putUChar("dassoc", diag.associated ? 1 : 0);
}

static void loadDiag() {
  diag.lastReason = prefs.getUShort("dr", 0);
  diag.rawReason = prefs.getUShort("drr", 0);
  diag.lastRssi = prefs.getChar("drssi", 0);
  diag.associated = prefs.getUChar("dassoc", 0) != 0;
  if (prefs.isKey("dssid")) {  // isKey first — getString on a missing key logs a scary error
    String s = prefs.getString("dssid", "");
    strncpy(diag.lastSsid, s.c_str(), sizeof(diag.lastSsid) - 1);
    diag.lastSsid[sizeof(diag.lastSsid) - 1] = '\0';
  }
  diag.valid = (diag.lastReason != 0) || diag.lastSsid[0] != '\0';
}

// Association succeeded (4-way handshake done, before DHCP). Reaching here proves the password
// is correct and the signal was good enough to join — so a later disconnect is a genuine kick,
// not a credential/range problem. Fires before STA_GOT_IP.
static void onWifiConnected(WiFiEvent_t, WiFiEventInfo_t) { associatedSinceConnect = true; }

// WiFi STA disconnect event — the only place the granular failure reason is exposed (the library
// surfaces only coarse status). The trap this guards against: reason 8 (ASSOC_LEAVE) is emitted
// both when the AP kicks us AND when *we* disconnect — and our own clean-connect + portal-teardown
// each fire a reason-8 event that would otherwise clobber the real failure (e.g. wrong password =
// 15) recorded just before it. So we keep the *most diagnostic* reason: a substantive code always
// wins; a "leave" code (3/8) is only trusted if we'd actually associated (→ a real post-assoc kick)
// or if it's the first/only thing we've seen this episode.
static void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  uint16_t reason = info.wifi_sta_disconnected.reason;
  diag.rawReason = reason;  // always: the unfiltered last code, as a sanity check

  bool firstThisAttempt = !attemptHasDiag;  // first event of a fresh episode replaces stale data
  attemptHasDiag = true;
  bool leaveCode = (reason == 3 || reason == 8);  // AUTH_LEAVE / ASSOC_LEAVE — often our own disconnect()
  if (firstThisAttempt || !leaveCode || associatedSinceConnect || diag.lastReason == 0) {
    diag.lastReason = reason;
    diag.associated = associatedSinceConnect;
    diag.lastRssi = info.wifi_sta_disconnected.rssi;
    uint8_t n = info.wifi_sta_disconnected.ssid_len;
    if (n >= sizeof(diag.lastSsid)) n = sizeof(diag.lastSsid) - 1;
    memcpy(diag.lastSsid, info.wifi_sta_disconnected.ssid, n);
    diag.lastSsid[n] = '\0';
  }
  diag.valid = true;
  associatedSinceConnect = false;  // this attempt is over; the next must re-associate to count
  saveDiag();
  TLOG(LOG_LEVEL_WARN, "WiFi disconnect: raw=%u (%s) kept=%u assoc=%d ssid=\"%s\" rssi=%d\n", reason,
       reasonToStr(reason), diag.lastReason, diag.associated, diag.lastSsid, diag.lastRssi);
}

// A one-line plain-English read of the last failure — the "what do I actually do" line. Turns on
// whether we *associated* (password proven correct, signal adequate) before failing, which the
// raw reason code alone can't tell you.
static const char* diagVerdict() {
  if (!diag.valid) return "No failure recorded yet.";
  if (diag.associated) {
    // We joined, then got dropped — definitely not the password. Almost always signal/policy.
    return "Joined, then the AP dropped us — NOT a password problem. Likely a weak-signal "
           "(minimum-RSSI) cutoff or band-steering on a managed AP. Get the device closer to an "
           "access point, or use a dedicated 2.4GHz SSID.";
  }
  switch (diag.lastReason) {
    case 2:
    case 15:
    case 202:
    case 204:
      return "Failed before joining, on auth/handshake — wrong password or a WPA-mode mismatch.";
    case 200:
    case 201:
      return "Couldn't reach the AP — out of range, a 5GHz-only SSID (the C3 is 2.4GHz only), or "
             "an SSID typo.";
    case 3:
    case 8:
      return "Refused before joining — the AP turned us away (MAC filter, minimum-signal, or "
             "band-steering).";
    default:
      return "Failed before joining — see the reason code.";
  }
}

// Build the diagnostics panel injected into the captive-portal landing page. Secret-safe: it
// shows the stored password *length*, never the plaintext — a too-short length is the tell
// that a special character (e.g. '#') was truncated before it reached WiFi.begin().
static void buildDiagHtml() {
  char macStr[18];
  macToStr(macStr, sizeof(macStr));
  const char* stored = provisionedSsid;  // cached at boot; see provisionedSsid (don't read the radio here)
  size_t passLen = wm.getWiFiPass(true).length();

  diagHtml = "<div class='tdiag'><h3>TallyBot diagnostics</h3>";
  if (diag.valid) {
    diagHtml += "<b>Diagnosis:</b> ";
    diagHtml += diagVerdict();
    diagHtml += "<br><b>Associated before failing:</b> ";
    diagHtml += (diag.associated ? "yes (password OK)" : "no");
    diagHtml += "<br><b>Last WiFi failure:</b> ";
    diagHtml += reasonToStr(diag.lastReason);
    diagHtml += " (code ";
    diagHtml += diag.lastReason;
    if (diag.rawReason != diag.lastReason) {  // our own teardown overwrote nothing — show both
      diagHtml += ", raw ";
      diagHtml += diag.rawReason;
    }
    diagHtml += ")<br>";
    diagHtml += "<b>SSID tried:</b> ";
    diagHtml += String(diag.lastSsid);
    diagHtml += "<br>";
    diagHtml += "<b>RSSI at failure:</b> ";
    diagHtml += diag.lastRssi;
    diagHtml += " dBm<br>";
  } else {
    diagHtml += "No prior WiFi failure recorded.<br>";
  }
  diagHtml += "<b>Stored SSID:</b> ";
  diagHtml += (stored[0] ? stored : "(none)");
  diagHtml += "<br><b>Stored password length:</b> ";
  diagHtml += passLen;
  diagHtml += " chars — if shorter than what you typed, a special char (e.g. #) was truncated.<br>";
  diagHtml += "<b>Firmware:</b> " FW_BUILD "<br>";
  diagHtml += "<b>MAC:</b> ";
  diagHtml += macStr;
  diagHtml += "</div>";
}

// Parse a "TALLY_HERE:<port>" datagram. Returns true and fills *port on success.
static bool parseDiscoveryResponse(const char* msg, uint16_t* port) {
  const size_t prefixLen = strlen(DISCOVERY_RESPONSE_PREFIX);
  if (strncmp(msg, DISCOVERY_RESPONSE_PREFIX, prefixLen) != 0) return false;
  char* end = nullptr;
  long p = strtol(msg + prefixLen, &end, 10);
  if (end == msg + prefixLen || p < 1 || p > 65535) return false;
  *port = (uint16_t)p;
  return true;
}

// Forward declarations for the provisioning actions (defined below, near the WiFi helpers).
static void applyWifiCreds(const char* ssid, const char* pass);
static void setTransportMode(uint8_t mode);
static void emitStatus();

// Act on one decoded server/host message. Shared by both byte sources (TCP FrameDecoder and
// the USB COBS handler) — the tally/LED logic doesn't care where the bytes came from. The
// provisioning kinds (SET_WIFI/SET_TRANSPORT/GET_STATUS) only ever arrive over USB; handling
// them unconditionally is harmless (the TCP server never sends them).
static void applyServerMessage(const ServerMessage& msg) {
  switch (msg.kind) {
    case ServerMessage::SET_COLOR: {
      // The brightness byte is a *perceptual* value, not a raw drive level — the device owns
      // the linearity correction (ARCHITECTURE.md "Brightness is a perceptual value"). The
      // sidecar/UI keep it linear; we gamma-correct here so the UI's even 0–10 levels appear
      // evenly spaced. applyGamma_video keeps a non-zero byte from collapsing to off.
      //
      // Server colours are rendered *steady*: the firmware stays lean and the server owns all
      // connected-state animation (the fault flash and the unassigned breathe are both driven by
      // the sidecar streaming frames over the wire). Device-local bring-up states animate locally
      // only because there's no server connected to drive them.
      uint8_t drive = applyGamma_video(msg.brightness, BRIGHTNESS_GAMMA);
      setResting(msg.r, msg.g, msg.b, drive, STEADY);
      TLOG(LOG_LEVEL_INFO, "SET_COLOR rgb(%u,%u,%u) brightness=%u (gamma->%u)\n", msg.r, msg.g, msg.b,
           msg.brightness, drive);
      break;
    }
    case ServerMessage::IDENTIFY:
      startIdentify();
      TLOG(LOG_LEVEL_INFO, "IDENTIFY\n");
      break;
    case ServerMessage::SET_WIFI:
      applyWifiCreds(msg.ssid, msg.pass);
      break;
    case ServerMessage::SET_TRANSPORT:
      setTransportMode(msg.transportMode);
      break;
    case ServerMessage::GET_STATUS:
      emitStatus();
      break;
    case ServerMessage::UNKNOWN:
      break;
  }
}

// TCP FrameDecoder callback: decode one length-framed payload and act on it.
static void onPayload(const uint8_t* payload, size_t len) {
  ServerMessage msg;
  if (!decodeServerMessage(payload, len, &msg)) return;  // skip unknown/malformed
  applyServerMessage(msg);
}

// USB PacketSerial callback: one COBS-deframed payload. Same dispatch as TCP, plus the
// USB-session bookkeeping — a host SET_COLOR means the app has taken over tally ("USB wins").
static void onUsbPacket(const uint8_t* payload, size_t len) {
  ServerMessage msg;
  if (!decodeServerMessage(payload, len, &msg)) return;
  hostFrameSeen = true;  // any host frame stops the HELLO re-announce
  if (msg.kind == ServerMessage::SET_COLOR) {
    usbTallyActive = true;  // the app drives tally now; local indicators step aside
    lastUsbTallyMsg = millis();
  }
  applyServerMessage(msg);
}

static void enterDiscovering(unsigned long now) {
  state = ST_DISCOVERING;
  lastDiscoveryBroadcast = now - DISCOVERY_INTERVAL_MS;  // broadcast on the next tick
  if (everHadServer) {
    setRestingLocal(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS, STEADY);  // state 10: lost the server (check the PC)
  } else {
    // state 4: first hunt for the server. A smooth pulse (not a hard blink) — calm, low
    // distraction in a live venue, while still clearly "alive and working".
    setRestingLocal(COLOR_SEARCHING, LOCAL_BRIGHTNESS, SLOW_PULSE);
  }
}

// Tear down and re-open the discovery socket on DISCOVERY_PORT (7001). The UDP socket may not
// survive an interface bounce / re-bind, so every path that (re-)enters discovery rebinds first.
static void rebindDiscoverySocket() {
  udp.stop();
  udp.begin(DISCOVERY_PORT);  // bind 7001 to catch both the unicast reply and broadcasts
}

// The real (BLOCKING) WiFi bring-up, factored out of setup() so the deferred USB-first path and
// the live unplug→WiFi revert share one definition. connectWithTxPolicy() may block on the captive
// portal; that's fine here because we only call this once we've established there's no USB host to
// starve. Lands us in DISCOVERING.
static bool connectWithTxPolicy();  // defined below; forward-declared for startWifiBringup()
static void startWifiBringup() {
  wifiBringupPending = false;
  WiFi.mode(WIFI_STA);            // belt-and-suspenders: the radio is already STA on a WiFi device
  connectWithTxPolicy();         // saved creds (full→low power), else the SoftAP captive portal
  rebindDiscoverySocket();
  enterDiscovering(millis());
}

// Connect to WiFi with the full-power-first, low-power-fallback policy, persisting whichever
// level works. Only after both levels fail do we raise the captive portal. Blocking is fine
// here — with no network the device can't do anything else anyway.
static bool connectWithTxPolicy() {
  uint8_t pol = loadTxPolicy();
  attemptHasDiag = false;  // fresh episode: the first disconnect event replaces any stale diag

  // Manage the portal ourselves so we get a genuine low-power retry *before* falling back to
  // provisioning, rather than WiFiManager raising the portal on the first failure.
  wm.setEnableConfigPortal(false);

  applyTxPower(pol);
  bool ok = wm.autoConnect(apSsid);
  if (ok) {
    saveTxPolicy(pol);
  } else if (pol != TXPOL_LOW && reasonSawAp(diag.lastReason)) {
    // We reached the AP but couldn't associate — try the low-power antenna workaround.
    TLOG(LOG_LEVEL_WARN, "connect failed but AP was seen - retrying at 8.5dBm (C3 antenna workaround)\n");
    applyTxPower(TXPOL_LOW);
    ok = wm.autoConnect(apSsid);
    if (ok) saveTxPolicy(TXPOL_LOW);
  } else if (!ok) {
    // AP not found (or already at low power): a low-power retry can't help — go to the portal.
    TLOG(LOG_LEVEL_WARN, "connect failed (reason %u, %s) - skipping low-power retry, opening portal\n",
         diag.lastReason, reasonToStr(diag.lastReason));
  }

  if (!ok) {
    TLOG(LOG_LEVEL_WARN, "both TX-power levels failed - opening the config portal\n");
    wm.setEnableConfigPortal(true);
    wm.startConfigPortal(apSsid);  // blocks until reconfigured + connected
    ok = true;
  }

  wm.setEnableConfigPortal(true);
  TLOG(LOG_LEVEL_INFO, "WiFi connected, IP %s (tx=%s)\n", WiFi.localIP().toString().c_str(),
       loadTxPolicy() == TXPOL_LOW ? "8.5dBm" : "full");
  return ok;
}

// Re-arm the captive portal after a sustained WiFi outage. Re-runs the full connect policy
// first (the AP may simply be back), only raising the portal if that fails. Blocking — fine,
// since with no WiFi the device can't do anything else.
static void reprovision() {
  TLOG(LOG_LEVEL_WARN, "WiFi down too long - re-running connect + config portal\n");
  state = ST_PROVISIONING;
  setRestingLocal(COLOR_SETUP, LOCAL_BRIGHTNESS, STEADY);  // magenta hint
  connectWithTxPolicy();
  rebindDiscoverySocket();
  wifiLostSince = 0;
  enterDiscovering(millis());
}

// Deliberately re-open the captive portal while otherwise connected, so the operator can
// point the device at a different network. Unlike reprovision(), this does NOT try the saved
// creds first (they're fine — that's the point); startConfigPortal() always raises the portal.
// Creds are not erased: entering a new network overwrites them; hitting Exit keeps the current
// one (we then restore the existing connection). Blocking is fine — same contract as setup().
static void forceReprovision() {
  TLOG(LOG_LEVEL_INFO, "Manual re-provision (BOOT held) - opening config portal\n");
  state = ST_PROVISIONING;
  // A deliberate reprovision is an explicit "bring WiFi up now" — cancel any pending USB-first
  // grace and end the USB-owned session so the loop runs the WiFi path after this returns.
  wifiBringupPending = false;
  usbSession = false;
  WiFi.mode(WIFI_STA);  // belt-and-suspenders: the radio is already STA on a WiFi device
  if (tcp.connected()) tcp.stop();
  setRestingLocal(COLOR_SETUP, LOCAL_BRIGHTNESS, STEADY);  // magenta (onConfigPortal repaints it too)
  bool reconfigured = wm.startConfigPortal(apSsid);
  if (!reconfigured && WiFi.status() != WL_CONNECTED) {
    TLOG(LOG_LEVEL_INFO, "portal exited without new creds - restoring the saved network\n");
    connectWithTxPolicy();
  }
  rebindDiscoverySocket();
  wifiLostSince = 0;
  everHadServer = false;  // fresh start: hunt for the server again (cyan), not "lost server"
  enterDiscovering(millis());
}

// Poll the BOOT button: a continuous hold of REPROVISION_HOLD_MS forces the captive portal.
// The hold is its own debounce (any release resets the timer); the LED turns magenta when it
// fires, which is the operator's "got it" cue — hold until it goes magenta.
static void checkReprovisionButton(unsigned long now) {
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {  // active-low: pressed
    if (btnDownSince == 0) {
      btnDownSince = now;
    } else if (now - btnDownSince >= REPROVISION_HOLD_MS) {
      btnDownSince = 0;
      forceReprovision();
    }
  } else {
    btnDownSince = 0;
  }
}

// WiFi has dropped out from under us. Tear down TCP, fall back to amber fast-blink ("network
// problem"), and let the core auto-reconnect; only after a sustained outage re-arm the AP.
static void handleWifiDown(unsigned long now) {
  if (tcp.connected()) tcp.stop();
  if (state == ST_CONNECTED || state == ST_CONNECTING) state = ST_DISCOVERING;
  setRestingLocal(COLOR_JOINING, LOCAL_BRIGHTNESS, FAST_BLINK);  // state 3: lost WiFi
  if (wifiLostSince == 0) {
    wifiLostSince = now;
    TLOG(LOG_LEVEL_WARN, "WiFi connection lost; waiting for auto-reconnect\n");
  } else if (now - wifiLostSince >= WIFI_LOST_PORTAL_MS) {
    reprovision();
  }
}

// WiFiManager raised the captive portal. Refresh + inject the diagnostics panel (so it shows
// this boot's failure reason) and show the magenta provisioning hint. Runs inside the blocking
// autoConnect/startConfigPortal call, so it takes effect before the user loads the page.
static void onConfigPortal(WiFiManager*) {
  TLOG(LOG_LEVEL_INFO, "Config portal up - join WiFi AP \"%s\", then open 192.168.4.1\n", apSsid);
  buildDiagHtml();
  wm.setCustomMenuHTML(diagHtml.c_str());
  setRestingLocal(COLOR_SETUP, LOCAL_BRIGHTNESS, STEADY);  // state 1: provisioning
}

// ── USB provisioning + status (v1.2) ─────────────────────────────────────────

// Mark the start of a host-visible WiFi join (a save-only SET_WIFI association, or the operational
// bring-up), so the streamed wifiState reads JOINING until it lands or settles into FAILED.
static void beginWifiJoin() {
  wifiJoinActive = true;
  wifiJoinStart = millis();
}

// Start a NON-BLOCKING background association from the stored NVS creds. STA + WiFi.begin() with no
// args reuses the persisted credentials, so the radio associates in the background while USB may own
// tally — keeping a provisioned device warm for an instant unplug revert and surfacing live
// wifiState/rssi in STATUS. Never blocks, never opens the captive portal. Returns false (and starts
// nothing) when there are no stored creds, so a factory device on USB doesn't trip a doomed join.
static bool beginWifiAssociation() {
  if (provisionedSsid[0] == '\0') return false;
  WiFi.persistent(true);
  WiFi.mode(WIFI_STA);
  applyTxPower(loadTxPolicy());  // remembered-good power level (the full→low ladder lives in the blocking path)
  WiFi.begin();                  // reuse the persisted STA creds — non-blocking
  attemptHasDiag = false;        // fresh episode: a stale loaded diag can't read as this boot's FAILED
  beginWifiJoin();               // host-visible JOINING in STATUS
  return true;
}

// The live wifiState from the real radio — the full enum, not just IDLE/CONNECTED. Provisioning
// itself stays save-only (applyWifiCreds never gates on this); this is purely the host-visible read
// of what the radio is doing, so the wizard can show a join progress live.
static uint8_t currentWifiState() {
  if (WiFi.status() == WL_CONNECTED) return WIFI_STATE_CONNECTED;
  if (!wifiJoinActive) return WIFI_STATE_IDLE;
  // A join is in flight. Report FAILED only for a settled, pre-association auth/handshake failure
  // (wrong password / WPA-mode mismatch: reasons 2/15/202/204, same set diagVerdict() categorises)
  // AFTER the debounce window — never on the C3's spurious first-disconnect transient, and never
  // for out-of-range (reasons 200/201 stay JOINING, so provisioning away from the AP isn't a fail).
  bool authFail = diag.valid && !diag.associated &&
                  (diag.lastReason == 2 || diag.lastReason == 15 || diag.lastReason == 202 ||
                   diag.lastReason == 204);
  if (authFail && millis() - wifiJoinStart >= WIFI_JOIN_FAIL_MS) return WIFI_STATE_FAILED;
  return WIFI_STATE_JOINING;
}

// The SSID to report in STATUS, read safely regardless of radio state — the single choke point that
// keeps STATUS from ever streaming garbage. When connected we use the live associated name; when the
// radio is STA-but-joining we use the boot-cached stored name; when the radio is off (No-TX) we report
// empty (ssidLen 0). We NEVER fall through to wm.getWiFiSSID(true) on a deinitialised radio, which is
// the uninitialised-stack read (no WIFI_MODE_NULL guard, unlike WiFiManager's password path) that
// produced the garbled SSID after an unplug/replug.
static String statusSsid() {
  if (WiFi.getMode() == WIFI_MODE_NULL) return String();   // radio off (No-TX): no SSID
  if (WiFi.status() == WL_CONNECTED) return WiFi.SSID();   // live associated name — always valid
  return String(provisionedSsid);                          // cached stored name (joining / not yet up)
}

// Push a STATUS frame: [transport][wifiState][rssi][ssidLen][ssid…]. Sent in reply to GET_STATUS,
// after a provisioning command, and (via maybeEmitStatus) whenever the data changes while a host is
// cabled. The SSID comes from statusSsid() so the host's stored name stays device-accurate.
static void emitStatus() {
  String ssid = statusSsid();
  uint8_t ws = currentWifiState();
  int8_t rssi = (WiFi.status() == WL_CONNECTED) ? (int8_t)WiFi.RSSI() : 0;
  uint8_t payload[37];  // 4-byte head + 1-byte len + up to 32 SSID bytes
  size_t n = encodeStatusPayload(payload, transportMode, ws, rssi, ssid.c_str(), (uint8_t)ssid.length());
  usbSendPayload(payload, n);
  // Remember what we just sent so the change-detector below suppresses duplicate frames.
  lastStatus.valid = true;
  lastStatus.transport = transportMode;
  lastStatus.wifiState = ws;
  lastStatus.rssi = rssi;
  strncpy(lastStatus.ssid, ssid.c_str(), sizeof(lastStatus.ssid) - 1);
  lastStatus.ssid[sizeof(lastStatus.ssid) - 1] = '\0';
}

// Emit a STATUS only when something a host cares about changed — gated on a connected USB host, so
// a deployed device on a power bank never streams into the void (CDC TX is non-blocking regardless).
// Called on a throttle from loop(), so a live join/drop/RSSI shift reaches the wizard without polling.
static void maybeEmitStatus() {
  if (!hostFrameSeen) return;
  String ssid = statusSsid();
  uint8_t ws = currentWifiState();
  int8_t rssi = (WiFi.status() == WL_CONNECTED) ? (int8_t)WiFi.RSSI() : 0;
  if (lastStatus.valid && ws == lastStatus.wifiState && transportMode == lastStatus.transport &&
      abs((int)rssi - (int)lastStatus.rssi) < STATUS_RSSI_DELTA_DBM &&
      strncmp(lastStatus.ssid, ssid.c_str(), sizeof(lastStatus.ssid)) == 0)
    return;
  emitStatus();
}

// SET_WIFI: SAVE-ONLY. Persist the creds (and imply "use WiFi when unplugged") and confirm at
// once — NO live/validating join. The operator must be able to provision from anywhere, not only
// in range of the target AP, so we never wait on or report a connection result here. This also
// sidesteps an ESP32-C3 bug where a *correct* password's first disconnect transiently reports
// reason 2/15 before the radio retries, which made a validating join fail a good password instantly.
//
// Persistence: WiFi.begin() with WiFi.persistent(true) writes the creds to the exact esp_wifi STA
// NVS config that WiFiManager.autoConnect() reads on the next boot — so the captive-portal fallback
// and BOOT-button reprovision keep working off one cred store. The resulting background association
// runs harmlessly while cabled; provisioning never gates or waits on it. It IS surfaced as live
// wifiState (JOINING → CONNECTED/FAILED) via the streamed STATUS, but only as display — the FAILED
// verdict is debounced past the C3 transient (see currentWifiState), so confirming the save never
// depends on a join result and a good password is never shown as a failure.
static void applyWifiCreds(const char* ssid, const char* pass) {
  TLOG(LOG_LEVEL_INFO, "SET_WIFI: saving creds for \"%s\" (save-only, no validating join)\n", ssid);
  WiFi.persistent(true);   // write creds to the NVS store autoConnect() reads
  WiFi.mode(WIFI_STA);     // STA mode so WiFi.begin persists into the STA config
  WiFi.begin(ssid, pass);  // persists the creds; its association is shown live but never gated on
  beginWifiJoin();         // the background association is now host-visible as JOINING
  strncpy(provisionedSsid, ssid, sizeof(provisionedSsid) - 1);  // refresh the cached name on re-provision
  provisionedSsid[sizeof(provisionedSsid) - 1] = '\0';
  // Provisioning a network implies "use WiFi when unplugged" — persist transport=WIFI so STATUS
  // (and the next boot's behaviour) reports WiFi, not whatever transport was set before.
  saveTransportMode(TRANSPORT_WIFI);
  transportMode = TRANSPORT_WIFI;
  emitStatus();            // immediate confirmation: transport=WIFI, ssid set, wifiState=JOINING
}

// SET_TRANSPORT: persist the unplugged behaviour. The radio change applies on the next boot
// (the device is replugged/power-cycled after provisioning) — we don't tear down a live link.
static void setTransportMode(uint8_t mode) {
  saveTransportMode(mode);
  transportMode = mode;
  if (mode == TRANSPORT_NOTX) wifiJoinActive = false;  // no join lifecycle in No-TX → wifiState IDLE
  TLOG(LOG_LEVEL_INFO, "SET_TRANSPORT: %s (applies on next boot)\n",
       mode == TRANSPORT_NOTX ? "No-TX" : "WiFi");
  emitStatus();
}

// Re-announce HELLO over USB every ~1s until the host sends its first frame (native USB-CDC has
// no clean connect event, and DTR must NOT be used as one — it would interrupt a live No-TX device).
static void serviceUsbHello(unsigned long now) {
  if (hostFrameSeen) return;
  if (now - lastUsbHello < USB_HELLO_INTERVAL_MS) return;
  lastUsbHello = now;
  uint8_t payload[8];
  size_t n = encodeHelloPayload(payload, mac);
  usbSendPayload(payload, n);
}

// Release USB tally ownership after the host falls silent (e.g. unplugged from the PC but still
// powered): local indicators — or a server colour re-pushed over TCP — resume driving the LED.
//
// Live unplug→WiFi revert: a WiFi-mode device that won the cabled session (`usbSession`) kept its
// radio warm (associated in the background) and stopped re-announcing HELLO once hostFrameSeen
// latched. If the USB host goes quiet on such a device, the cable's data link is gone but power may
// remain (power bank) — so we hand the device back to its provisioned WiFi transport: end the USB
// session and re-announce HELLO. Because the association is already warm, the common case goes
// straight to discovery (no blocking bring-up); if the radio never associated (creds missing / out of
// range), we fall back to the full bring-up. Either way satisfies the AC "unplug it → it transitions
// to WiFi" without a reboot. (A No-TX device isn't wifiEnabled, and a deployed WiFi device never set
// usbSession, so both keep their existing path.)
static void serviceUsbTally(unsigned long now) {
  if (usbTallyActive && now - lastUsbTallyMsg >= USB_TALLY_IDLE_MS) {
    usbTallyActive = false;
    TLOG(LOG_LEVEL_INFO, "USB tally idle; releasing local indicators\n");

    if (wifiEnabled && usbSession) {
      usbSession = false;          // hand the session back to the WiFi state machine
      hostFrameSeen = false;       // re-announce HELLO (in case USB comes back) + allow a fresh win
      lastStatus.valid = false;    // a future USB session re-syncs STATUS from scratch
      lastUsbHello = now - USB_HELLO_INTERVAL_MS;  // announce immediately
      if (WiFi.status() == WL_CONNECTED) {
        // Warm association already up — go straight to the tally client, no blocking bring-up.
        TLOG(LOG_LEVEL_INFO, "USB host lost; WiFi already associated, entering discovery\n");
        rebindDiscoverySocket();
        enterDiscovering(now);
      } else {
        // Not associated yet (creds missing / out of range): run the full bring-up, which applies the
        // TX-power ladder and, if needed, the captive portal. No grace — the cable's data is gone.
        TLOG(LOG_LEVEL_INFO, "USB host lost; WiFi not yet associated, starting bring-up\n");
        beginWifiAssociation();      // (re)start the warm join if we have creds
        wifiBringupPending = true;   // loop() runs startWifiBringup()
        bootStart = now - USB_BOOT_GRACE_MS;  // skip the grace window — we already know USB went away
        setRestingLocal(COLOR_JOINING, LOCAL_BRIGHTNESS, SLOW_PULSE);  // back to the "joining" pulse
      }
    }
  }
}

// Bring up the USB-CDC control channel. setTxTimeoutMs(0) is MANDATORY — without it CDC TX
// blocks when the host isn't reading and stalls the FastLED render loop (arduino-esp32 #7779).
static void usbBegin() {
  Serial.setTxTimeoutMs(0);
  usbPacket.setStream(&Serial);
  usbPacket.setPacketHandler(&onUsbPacket);
}

// Drain all available USB-CDC RX into the COBS parser. Called every loop iteration (in every
// state) so device→host TX never stalls and provisioning works regardless of WiFi state.
static void usbLoop() { usbPacket.update(); }

// ── Arduino entry points ─────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  // Bounded wait for USB-CDC to enumerate (not `while (!Serial)`): the board may run headless
  // off a power bank with no host attached, and must never block there.
  unsigned long start = millis();
  while (!Serial && millis() - start < 2000) delay(10);
  usbBegin();  // COBS control channel up before any TLOG (release builds frame logs)

  WiFi.macAddress(mac);
  // AP SSID from the last 3 MAC octets, uppercase — "TallyLight-XXXXXX".
  snprintf(apSsid, sizeof(apSsid), "TallyLight-%02X%02X%02X", mac[3], mac[4], mac[5]);

  char macStr[18];
  macToStr(macStr, sizeof(macStr));
  TLOG(LOG_LEVEL_INFO, "=== TallyBot tally light ===\n");
  TLOG(LOG_LEVEL_INFO, "chip: %s rev %d   fw: %s\n", ESP.getChipModel(), ESP.getChipRevision(), FW_BUILD);
  TLOG(LOG_LEVEL_INFO, "MAC:  %s   AP: %s\n", macStr, apSsid);

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);  // BOOT button: hold at runtime to re-open WiFi setup

  FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, NUM_LEDS);
  bootSelfTest();  // R→G→B→W — prove the LED works before anything network-related

  prefs.begin("tally", false);  // NVS: TX-power policy + last-failure diagnostics + transport mode
  loadDiag();                   // surface the previous boot's failure on the portal
  transportMode = loadTransportMode();
  wifiEnabled = (transportMode == TRANSPORT_WIFI);

  // Cache the stored SSID once, now, while we can read it safely — every later read (the diag panel
  // below, STATUS while joining) uses provisionedSsid, never wm.getWiFiSSID(true) on a possibly-off
  // radio. A WiFi device needs STA up for the esp_wifi config read to be valid (WiFiManager's
  // persistent read returns uninitialised stack garbage otherwise); a No-TX device keeps the radio
  // off and simply has no SSID to show.
  if (wifiEnabled) {
    WiFi.mode(WIFI_STA);
    String stored = wm.getWiFiSSID(true);
    strncpy(provisionedSsid, stored.c_str(), sizeof(provisionedSsid) - 1);
    provisionedSsid[sizeof(provisionedSsid) - 1] = '\0';
  }

  // Granular disconnect reasons reach us only via the event (the library exposes coarse status).
  // STA_CONNECTED tells us we associated — the key signal for the "kicked vs never-joined" verdict.
  // Registered unconditionally so a USB-provisioning join (even on a No-TX device) is diagnosed.
  WiFi.onEvent(onWifiEvent, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.onEvent(onWifiConnected, ARDUINO_EVENT_WIFI_STA_CONNECTED);

  // WiFiManager config — cheap to set up and needed by the captive-portal fallback / BOOT-button
  // reprovision regardless of transport mode.
  wm.setConnectTimeout(WIFI_CONNECT_TIMEOUT_S);
  wm.setConnectRetries(WIFI_CONNECT_RETRIES);
  wm.setCleanConnect(true);  // disconnect before each attempt — clears stale half-handshake state
  wm.setAPCallback(onConfigPortal);
  // Put our diagnostics block on the portal's landing page ("custom" token) for zero navigation.
  const char* menu[] = {"custom", "wifi", "info", "exit"};
  wm.setMenu(menu, 4);
  wm.setCustomHeadElement(
      "<style>.tdiag{font-family:monospace;font-size:14px;padding:10px;border:1px solid #888;"
      "border-radius:6px;margin:10px 0;background:#f6f6f6;color:#111}</style>");
  buildDiagHtml();
  wm.setCustomMenuHTML(diagHtml.c_str());
#ifdef WM_DEBUG
  wm.setDebugOutput(true);  // loud library-internal connection trace (opt-in build flag)
#endif

  state = ST_PROVISIONING;
  if (wifiEnabled) {
    setResting(COLOR_JOINING, LOCAL_BRIGHTNESS, SLOW_PULSE);  // state 2: about to join WiFi
    // (radio already in STA from the SSID-cache read above)

    // Widen the usable 2.4GHz channels. A manual 1–13 range (vs the chip's cautious "world-safe"
    // default) ensures channels 12/13 are scannable/usable — some venues sit an AP there. cc is
    // South Africa; max_tx_power left high so it doesn't cap the radio (we set power below).
    // NB: do NOT use wm.setCountry()/esp_wifi_set_country_code("ZA") — the IDF's validated
    // country-code table has no "ZA", so it returns ESP_ERR_WIFI_ARG and the country never gets
    // set. The older esp_wifi_set_country() takes an explicit channel range and doesn't validate
    // the cc against that table, so a manual 1–13 range works regardless of the code string.
    wifi_country_t country = {};
    memcpy(country.cc, WIFI_COUNTRY, sizeof(country.cc));
    country.schan = 1;
    country.nchan = 13;
    country.max_tx_power = 84;  // 21 dBm in 0.25dBm units — don't constrain
    country.policy = WIFI_COUNTRY_POLICY_MANUAL;
    esp_err_t cerr = esp_wifi_set_country(&country);
    TLOG(LOG_LEVEL_INFO, "WiFi country %s ch1-13: %s\n", WIFI_COUNTRY,
         cerr == ESP_OK ? "ok" : esp_err_to_name(cerr));

    // WPA3-SAE transition mode is enabled by default in this core; no code needed. A WPA3-only AP
    // that still fails will surface as reason 202/204 on the diagnostics panel above.
    //
    // USB-first boot: do NOT call connectWithTxPolicy()/udp.begin()/enterDiscovering() here — that
    // path is BLOCKING (autoConnect times out on saved creds, then startConfigPortal() waits on a
    // human at the SoftAP) and would run before loop() ever services USB, leaving a cabled device
    // dead on the wire. Instead arm a pending flag and let loop() either hand off to USB (if a host
    // HELLO-reply arrives within the grace window) or run this same bring-up once the window lapses.
    // The LED rests on the calm "joining" pulse meanwhile (state 2) — visually identical to the old
    // immediate-join, so a deployed device looks no different during the ~2.5s grace.
    //
    // We DO start the NON-BLOCKING warm association now (if provisioned): it associates in the
    // background regardless of who wins the cabled session, so an already-provisioned device shows
    // joining→connected (+RSSI) in STATUS while cabled and is warm for an instant unplug revert. Only
    // the BLOCKING bring-up (the captive-portal fallback) is deferred to the grace window below.
    beginWifiAssociation();
    wifiBringupPending = true;
    bootStart = millis();
  } else {
    // No-TX: the device lives only on the USB cable. Disable the radio (no wireless attempt when
    // unplugged) and rest on steady blue until the app connects over USB and drives tally.
    WiFi.mode(WIFI_OFF);
    TLOG(LOG_LEVEL_INFO, "No-TX mode: WiFi disabled; USB only\n");
    setRestingLocal(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS, STEADY);
  }
}

void loop() {
  unsigned long now = millis();

  // Service the USB-CDC control channel every iteration, in every state and before the WiFi
  // branches below — so RX never stalls TX and provisioning works even with WiFi down/off.
  usbLoop();
  serviceUsbHello(now);   // re-announce HELLO until the host replies
  serviceUsbTally(now);   // release USB tally ownership after idle (unplug-but-powered revert)

  // Hold BOOT to deliberately re-open WiFi setup (e.g. to switch networks), in any state.
  checkReprovisionButton(now);

  // Stream STATUS on change while a USB host is cabled (here, before the per-state early returns, so
  // it runs in every state — a live SET_WIFI join, an RSSI shift, a transport change all reach the
  // wizard without it polling). Throttled; maybeEmitStatus() self-gates on hostFrameSeen + a real diff.
  if (now - lastStatusEmit >= STATUS_EMIT_INTERVAL_MS) {
    lastStatusEmit = now;
    maybeEmitStatus();
  }

  // USB-first boot for a WiFi-mode device: decide between handing the cabled session to USB and
  // starting the (blocking) WiFi join. serviceUsbHello() above has already begun announcing HELLO,
  // so the host can detect us during this window.
  if (wifiBringupPending) {
    if (hostFrameSeen) {
      // USB won: a host frame arrived, so there's a PC on the cable. Tally now flows over USB via
      // applyServerMessage()/usbTallyActive. We DON'T park the radio off: the warm association started
      // in setup keeps running, so STATUS streams live wifiState/rssi/ssid and unplug-revert is
      // instant. The usbSession gate below (not the radio mode) is what keeps us off the WiFi tally
      // state machine, so we never double-connect to the sidecar over WiFi while USB owns tally.
      wifiBringupPending = false;
      usbSession = true;       // USB owns this session — keep us off the WiFi state machine
      TLOG(LOG_LEVEL_INFO, "USB host detected at boot; USB owns tally (WiFi association kept warm)\n");
    } else if (now - bootStart >= USB_BOOT_GRACE_MS) {
      // No USB host answered in the grace window → deployed / on a power bank. Run the real WiFi
      // bring-up now (this may block on the captive portal — fine, there's no USB host to starve).
      TLOG(LOG_LEVEL_INFO, "No USB host within %dms; starting WiFi bring-up\n", USB_BOOT_GRACE_MS);
      startWifiBringup();
    }
    // Still waiting: render the resting "joining" pulse and yield. Don't fall through to the WiFi
    // state machine — the radio isn't connecting yet.
    if (wifiBringupPending) {
      renderLed(now);
      delay(1);
      return;
    }
    // If USB won we fall through to the early return below (gated on usbSession), which services the
    // LED over USB while the WiFi association stays warm. If we just started the bring-up, the state
    // machine runs as usual.
  }

  // No-TX (or a WiFi device that handed this session to USB): USB-only, no WiFi state machine.
  // The LED is driven by USB (app) or the local blue. `usbSession` (not the radio mode) gates this,
  // so a save-only SET_WIFI re-enabling WIFI_STA doesn't yank a cabled device onto the WiFi path.
  if (!wifiEnabled || usbSession) {
    renderLed(now);
    delay(1);
    return;
  }

  // WiFi is the authoritative "network up" signal, distinct from a TCP drop.
  if (WiFi.status() != WL_CONNECTED) {
    handleWifiDown(now);
    renderLed(now);
    delay(1);
    return;
  }
  if (wifiLostSince != 0) {  // WiFi just came back without needing the portal
    TLOG(LOG_LEVEL_INFO, "WiFi reconnected, IP %s\n", WiFi.localIP().toString().c_str());
    wifiLostSince = 0;
    rebindDiscoverySocket();
    enterDiscovering(now);
  }

  switch (state) {
    case ST_PROVISIONING:
      // Reached only transiently; setup()/reprovision() leave us in ST_DISCOVERING.
      enterDiscovering(now);
      break;

    case ST_DISCOVERING: {
      if (now - lastDiscoveryBroadcast >= DISCOVERY_INTERVAL_MS) {
        udp.beginPacket(IPAddress(255, 255, 255, 255), DISCOVERY_PORT);
        udp.write((const uint8_t*)DISCOVERY_REQUEST, strlen(DISCOVERY_REQUEST));
        udp.endPacket();
        lastDiscoveryBroadcast = now;
      }
      int sz = udp.parsePacket();
      if (sz > 0) {
        char buf[32];
        int n = udp.read((uint8_t*)buf, sizeof(buf) - 1);
        if (n < 0) n = 0;
        buf[n] = '\0';
        uint16_t port;
        if (parseDiscoveryResponse(buf, &port)) {
          serverIp = udp.remoteIP();  // valid right after parsePacket(): the server's IP
          serverPort = port;
          TLOG(LOG_LEVEL_INFO, "Found server at %s:%u\n", serverIp.toString().c_str(), port);
          state = ST_CONNECTING;
        }
      }
      break;
    }

    case ST_CONNECTING: {
      decoder.reset();
      if (tcp.connect(serverIp, serverPort, TCP_CONNECT_TIMEOUT_MS)) {
        uint8_t hello[9];
        size_t n = encodeHello(hello, mac);
        tcp.write(hello, n);
        lastHeartbeat = now;
        everHadServer = true;  // from now on, a "no server" signal means we LOST one (state 10)
        state = ST_CONNECTED;
        TLOG(LOG_LEVEL_INFO, "Connected to %s:%u; HELLO sent\n", serverIp.toString().c_str(), serverPort);
        // Connected but not yet assigned: white breathe locally until the first SET_COLOR.
        setRestingLocal(COLOR_UNASSIGNED, LOCAL_BRIGHTNESS, BREATHE);  // state 5
      } else {
        TLOG(LOG_LEVEL_WARN, "TCP connect failed; backing off\n");
        backoffStart = now;
        state = ST_BACKOFF;
      }
      break;
    }

    case ST_CONNECTED: {
      if (!tcp.connected() && tcp.available() == 0) {
        TLOG(LOG_LEVEL_WARN, "Server connection lost\n");
        tcp.stop();
        setRestingLocal(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS, STEADY);  // state 10: lost the server
        backoffStart = now;
        state = ST_BACKOFF;
        break;
      }
      uint8_t chunk[64];
      while (tcp.available() > 0) {
        int n = tcp.read(chunk, sizeof(chunk));
        if (n <= 0) break;
        decoder.push(chunk, (size_t)n, onPayload);
      }
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        uint8_t hb[2];
        encodeHeartbeat(hb);
        tcp.write(hb, 2);
        lastHeartbeat = now;
      }
      break;
    }

    case ST_BACKOFF:
      if (now - backoffStart >= BACKOFF_MS) enterDiscovering(now);
      break;
  }

  renderLed(now);
  delay(1);  // yield to the WiFi stack / feed the watchdog — not a sleep
}

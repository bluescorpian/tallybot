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
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiManager.h>  // tzapu/WiFiManager — SoftAP captive portal + NVS creds
#include <WiFiUdp.h>
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

// WiFi connection policy (the venue-failure mitigations — see ../../FIELD-TEST-FINDINGS.md).
#define WIFI_COUNTRY "ZA"            // South Africa: 2.4GHz channels 1–13 (the widest legal set here)
#define WIFI_CONNECT_TIMEOUT_S 10    // per-attempt connect window; enough for association + DHCP
#define WIFI_CONNECT_RETRIES 2       // attempts per autoConnect pass (clamped 1–10 by the lib)

// LED motion timing (ms).
#define PULSE_PERIOD_MS 1500   // SLOW_PULSE full cycle (joining WiFi, searching for the server)
#define BREATHE_PERIOD_MS 10000  // BREATHE full cycle (unassigned) — slow, calm
#define FAST_BLINK_MS 200      // FAST_BLINK half-period (lost WiFi)
#define BOOT_TEST_STEP_MS 250  // each colour in the power-on self-test

// Firmware build stamp, shown on the SoftAP diagnostics panel.
#define FW_BUILD __DATE__ " " __TIME__

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
static WiFiManager wm;
static WiFiUDP udp;
static WiFiClient tcp;
static FrameDecoder decoder;
static IPAddress serverIp;
static uint16_t serverPort = SERVER_PORT;
static Preferences prefs;  // NVS: TX-power policy + last-failure diagnostics ("tally" namespace)

// Last WiFi-disconnect diagnostics — surfaced on the SoftAP portal (the "serial monitor over
// the phone") and persisted so the failure that triggered the portal survives the reboot.
struct WifiDiag {
  uint16_t lastReason = 0;    // wifi_err_reason_t numeric (0 = none recorded)
  int8_t lastRssi = 0;        // RSSI reported with the disconnect
  char lastSsid[33] = {0};    // SSID the device was trying
  bool valid = false;
};
static WifiDiag diag;
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

static void applyTxPower(uint8_t policy) {
  WiFi.setTxPower(policy == TXPOL_LOW ? WIFI_POWER_8_5dBm : WIFI_POWER_19_5dBm);
}

// Did we actually reach the AP (but fail to associate/authenticate)? That's the only case the
// ESP32-C3 low-TX-power antenna workaround can help, so it's the only case worth a second,
// slower pass at low power. NO_AP_FOUND (201) / beacon timeout (200) / no event (0) mean the AP
// wasn't on the air for us — lower power can't conjure it, so skip the retry and go to the
// portal. This keeps time-to-portal short without ever skipping a connection low power'd land.
static bool reasonSawAp(uint16_t r) { return r != 0 && r != 201 && r != 200; }

// Persist the latest failure (only when the reason changes — bounds NVS wear during a retry
// storm) so the SoftAP panel can show it after the portal-triggering reboot.
static void saveDiag() {
  if (prefs.getUShort("dr", 0xFFFF) == diag.lastReason) return;
  prefs.putUShort("dr", diag.lastReason);
  prefs.putChar("drssi", diag.lastRssi);
  prefs.putString("dssid", diag.lastSsid);
}

static void loadDiag() {
  diag.lastReason = prefs.getUShort("dr", 0);
  diag.lastRssi = prefs.getChar("drssi", 0);
  if (prefs.isKey("dssid")) {  // isKey first — getString on a missing key logs a scary error
    String s = prefs.getString("dssid", "");
    strncpy(diag.lastSsid, s.c_str(), sizeof(diag.lastSsid) - 1);
    diag.lastSsid[sizeof(diag.lastSsid) - 1] = '\0';
  }
  diag.valid = (diag.lastReason != 0) || diag.lastSsid[0] != '\0';
}

// WiFi STA disconnect event — the only place the granular failure reason is exposed (the
// library surfaces only coarse status). Capture it for the portal panel and the serial log.
static void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  diag.lastReason = info.wifi_sta_disconnected.reason;
  diag.lastRssi = info.wifi_sta_disconnected.rssi;
  uint8_t n = info.wifi_sta_disconnected.ssid_len;
  if (n >= sizeof(diag.lastSsid)) n = sizeof(diag.lastSsid) - 1;
  memcpy(diag.lastSsid, info.wifi_sta_disconnected.ssid, n);
  diag.lastSsid[n] = '\0';
  diag.valid = true;
  saveDiag();
  Serial.printf("WiFi disconnect: reason=%u (%s) ssid=\"%s\" rssi=%d\n", diag.lastReason,
                reasonToStr(diag.lastReason), diag.lastSsid, diag.lastRssi);
}

// Build the diagnostics panel injected into the captive-portal landing page. Secret-safe: it
// shows the stored password *length*, never the plaintext — a too-short length is the tell
// that a special character (e.g. '#') was truncated before it reached WiFi.begin().
static void buildDiagHtml() {
  char macStr[18];
  macToStr(macStr, sizeof(macStr));
  String stored = wm.getWiFiSSID(true);
  size_t passLen = wm.getWiFiPass(true).length();

  diagHtml = "<div class='tdiag'><h3>TallyBot diagnostics</h3>";
  if (diag.valid) {
    diagHtml += "<b>Last WiFi failure:</b> ";
    diagHtml += reasonToStr(diag.lastReason);
    diagHtml += " (code ";
    diagHtml += diag.lastReason;
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
  diagHtml += (stored.length() ? stored : String("(none)"));
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

// Decode one framed server payload and act on it. Used as the FrameDecoder callback.
static void onPayload(const uint8_t* payload, size_t len) {
  ServerMessage msg;
  if (!decodeServerMessage(payload, len, &msg)) return;  // skip unknown/malformed
  if (msg.kind == ServerMessage::SET_COLOR) {
    // The brightness byte is a *perceptual* value, not a raw drive level — the device owns
    // the linearity correction (ARCHITECTURE.md "Brightness is a perceptual value"). The
    // sidecar/UI keep it linear; we gamma-correct here so the UI's even 0–10 levels appear
    // evenly spaced. applyGamma_video keeps a non-zero byte from collapsing to off.
    uint8_t drive = applyGamma_video(msg.brightness, BRIGHTNESS_GAMMA);
    setResting(msg.r, msg.g, msg.b, drive, STEADY);  // server colours are steady
    Serial.printf("SET_COLOR rgb(%u,%u,%u) brightness=%u (gamma→%u)\n", msg.r, msg.g, msg.b,
                  msg.brightness, drive);
  } else if (msg.kind == ServerMessage::IDENTIFY) {
    startIdentify();
    Serial.println("IDENTIFY");
  }
}

static void enterDiscovering(unsigned long now) {
  state = ST_DISCOVERING;
  lastDiscoveryBroadcast = now - DISCOVERY_INTERVAL_MS;  // broadcast on the next tick
  if (everHadServer) {
    setResting(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS, STEADY);  // state 10: lost the server (check the PC)
  } else {
    // state 4: first hunt for the server. A smooth pulse (not a hard blink) — calm, low
    // distraction in a live venue, while still clearly "alive and working".
    setResting(COLOR_SEARCHING, LOCAL_BRIGHTNESS, SLOW_PULSE);
  }
}

// Connect to WiFi with the full-power-first, low-power-fallback policy, persisting whichever
// level works. Only after both levels fail do we raise the captive portal. Blocking is fine
// here — with no network the device can't do anything else anyway.
static bool connectWithTxPolicy() {
  uint8_t pol = loadTxPolicy();

  // Manage the portal ourselves so we get a genuine low-power retry *before* falling back to
  // provisioning, rather than WiFiManager raising the portal on the first failure.
  wm.setEnableConfigPortal(false);

  applyTxPower(pol);
  bool ok = wm.autoConnect(apSsid);
  if (ok) {
    saveTxPolicy(pol);
  } else if (pol != TXPOL_LOW && reasonSawAp(diag.lastReason)) {
    // We reached the AP but couldn't associate — try the low-power antenna workaround.
    Serial.println("connect failed but AP was seen — retrying at 8.5dBm (C3 antenna workaround)");
    applyTxPower(TXPOL_LOW);
    ok = wm.autoConnect(apSsid);
    if (ok) saveTxPolicy(TXPOL_LOW);
  } else if (!ok) {
    // AP not found (or already at low power): a low-power retry can't help — go to the portal.
    Serial.printf("connect failed (reason %u, %s) — skipping low-power retry, opening portal\n",
                  diag.lastReason, reasonToStr(diag.lastReason));
  }

  if (!ok) {
    Serial.println("both TX-power levels failed — opening the config portal");
    wm.setEnableConfigPortal(true);
    wm.startConfigPortal(apSsid);  // blocks until reconfigured + connected
    ok = true;
  }

  wm.setEnableConfigPortal(true);
  Serial.printf("WiFi connected, IP %s (tx=%s)\n", WiFi.localIP().toString().c_str(),
                loadTxPolicy() == TXPOL_LOW ? "8.5dBm" : "full");
  return ok;
}

// Re-arm the captive portal after a sustained WiFi outage. Re-runs the full connect policy
// first (the AP may simply be back), only raising the portal if that fails. Blocking — fine,
// since with no WiFi the device can't do anything else.
static void reprovision() {
  Serial.println("WiFi down too long — re-running connect + config portal");
  state = ST_PROVISIONING;
  setResting(COLOR_SETUP, LOCAL_BRIGHTNESS, STEADY);  // magenta hint
  connectWithTxPolicy();
  udp.stop();
  udp.begin(DISCOVERY_PORT);
  wifiLostSince = 0;
  enterDiscovering(millis());
}

// Deliberately re-open the captive portal while otherwise connected, so the operator can
// point the device at a different network. Unlike reprovision(), this does NOT try the saved
// creds first (they're fine — that's the point); startConfigPortal() always raises the portal.
// Creds are not erased: entering a new network overwrites them; hitting Exit keeps the current
// one (we then restore the existing connection). Blocking is fine — same contract as setup().
static void forceReprovision() {
  Serial.println("Manual re-provision (BOOT held) — opening config portal");
  state = ST_PROVISIONING;
  if (tcp.connected()) tcp.stop();
  setResting(COLOR_SETUP, LOCAL_BRIGHTNESS, STEADY);  // magenta (onConfigPortal repaints it too)
  bool reconfigured = wm.startConfigPortal(apSsid);
  if (!reconfigured && WiFi.status() != WL_CONNECTED) {
    Serial.println("portal exited without new creds — restoring the saved network");
    connectWithTxPolicy();
  }
  udp.stop();
  udp.begin(DISCOVERY_PORT);
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
  setResting(COLOR_JOINING, LOCAL_BRIGHTNESS, FAST_BLINK);  // state 3: lost WiFi
  if (wifiLostSince == 0) {
    wifiLostSince = now;
    Serial.println("WiFi connection lost; waiting for auto-reconnect");
  } else if (now - wifiLostSince >= WIFI_LOST_PORTAL_MS) {
    reprovision();
  }
}

// WiFiManager raised the captive portal. Refresh + inject the diagnostics panel (so it shows
// this boot's failure reason) and show the magenta provisioning hint. Runs inside the blocking
// autoConnect/startConfigPortal call, so it takes effect before the user loads the page.
static void onConfigPortal(WiFiManager*) {
  Serial.printf("Config portal up — join WiFi AP \"%s\", then open 192.168.4.1\n", apSsid);
  buildDiagHtml();
  wm.setCustomMenuHTML(diagHtml.c_str());
  setResting(COLOR_SETUP, LOCAL_BRIGHTNESS, STEADY);  // state 1: provisioning
}

// ── Arduino entry points ─────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  // Bounded wait for USB-CDC to enumerate (not `while (!Serial)`): the board may run headless
  // off a power bank with no host attached, and must never block there.
  unsigned long start = millis();
  while (!Serial && millis() - start < 2000) delay(10);

  WiFi.macAddress(mac);
  // AP SSID from the last 3 MAC octets, uppercase — "TallyLight-XXXXXX".
  snprintf(apSsid, sizeof(apSsid), "TallyLight-%02X%02X%02X", mac[3], mac[4], mac[5]);

  char macStr[18];
  macToStr(macStr, sizeof(macStr));
  Serial.println();
  Serial.println(F("=== TallyBot tally light ==="));
  Serial.printf("chip: %s rev %d   fw: %s\n", ESP.getChipModel(), ESP.getChipRevision(), FW_BUILD);
  Serial.printf("MAC:  %s   AP: %s\n", macStr, apSsid);

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);  // BOOT button: hold at runtime to re-open WiFi setup

  FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, NUM_LEDS);
  bootSelfTest();  // R→G→B→W — prove the LED works before anything network-related
  setResting(COLOR_JOINING, LOCAL_BRIGHTNESS, SLOW_PULSE);  // state 2: about to join WiFi

  prefs.begin("tally", false);  // NVS: TX-power policy + last-failure diagnostics
  loadDiag();                   // surface the previous boot's failure on the portal

  WiFi.mode(WIFI_STA);

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
  Serial.printf("WiFi country %s ch1-13: %s\n", WIFI_COUNTRY,
                cerr == ESP_OK ? "ok" : esp_err_to_name(cerr));

  // Granular disconnect reasons reach us only via the event (the library exposes coarse status).
  WiFi.onEvent(onWifiEvent, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  // Provision: connect with saved creds (full power, low fallback), or raise the SoftAP captive
  // portal. Creds persist to NVS, so the portal only opens on first boot or when creds fail.
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

  // WPA3-SAE transition mode is enabled by default in this core; no code needed. A WPA3-only AP
  // that still fails will surface as reason 202/204 on the diagnostics panel above.
  state = ST_PROVISIONING;
  connectWithTxPolicy();

  udp.begin(DISCOVERY_PORT);  // bind 7001 to catch both the unicast reply and broadcasts
  enterDiscovering(millis());
}

void loop() {
  unsigned long now = millis();

  // Hold BOOT to deliberately re-open WiFi setup (e.g. to switch networks), in any state.
  checkReprovisionButton(now);

  // WiFi is the authoritative "network up" signal, distinct from a TCP drop.
  if (WiFi.status() != WL_CONNECTED) {
    handleWifiDown(now);
    renderLed(now);
    delay(1);
    return;
  }
  if (wifiLostSince != 0) {  // WiFi just came back without needing the portal
    Serial.printf("WiFi reconnected, IP %s\n", WiFi.localIP().toString().c_str());
    wifiLostSince = 0;
    udp.stop();
    udp.begin(DISCOVERY_PORT);  // the socket may not survive an interface bounce
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
          Serial.printf("Found server at %s:%u\n", serverIp.toString().c_str(), port);
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
        Serial.printf("Connected to %s:%u; HELLO sent\n", serverIp.toString().c_str(), serverPort);
        // Connected but not yet assigned: white breathe locally until the first SET_COLOR.
        setResting(COLOR_UNASSIGNED, LOCAL_BRIGHTNESS, BREATHE);  // state 5
      } else {
        Serial.println("TCP connect failed; backing off");
        backoffStart = now;
        state = ST_BACKOFF;
      }
      break;
    }

    case ST_CONNECTED: {
      if (!tcp.connected() && tcp.available() == 0) {
        Serial.println("Server connection lost");
        tcp.stop();
        setResting(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS, STEADY);  // state 10: lost the server
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

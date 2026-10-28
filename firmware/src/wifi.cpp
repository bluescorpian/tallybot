#include "wifi.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <esp_wifi.h>
#include <string.h>

#include "indicators.h"
#include "log.h"
#include "protocol.h"

#ifndef BUILD_TIMESTAMP
#define BUILD_TIMESTAMP __DATE__ " " __TIME__
#endif

namespace {
constexpr const char* kCountry = "ZA";       // 2.4GHz channels 1–13 (the widest legal set here)
constexpr int kConnectTimeoutS = 10;
constexpr int kConnectRetries = 2;
constexpr unsigned long kLostPortalMs = 60000;  // sustained loss before re-arming the portal
constexpr unsigned long kJoinFailMs = 12000;     // settle window before a stuck join reads FAILED

WiFiManager g_wm;
char g_apSsid[24] = {0};
char g_storedSsid[33] = {0};  // cached while STA is up — the safe source for the stored name
String g_diagHtml;            // must outlive g_wm (it keeps the pointer)

// The last disconnect, for the one-line portal verdict. Live only — not persisted across reboot.
struct {
  bool valid = false;
  uint16_t reason = 0;
  bool associated = false;  // reached the 4-way handshake (→ password OK) before failing?
  int8_t rssi = 0;
} g_diag;
bool g_associated = false;  // associated in the current connect episode

// Set from the main loop, read in the event task's onDisconnected: SCAN_WIFI paused the join.
volatile bool g_joinPaused = false;

// Host-visible join lifecycle for STATUS.
bool g_joinActive = false;
unsigned long g_joinStart = 0;
unsigned long g_lostSince = 0;

bool authFailed() {
  return g_diag.valid && !g_diag.associated &&
         (g_diag.reason == 2 || g_diag.reason == 15 || g_diag.reason == 202 || g_diag.reason == 204);
}

const char* reasonText(uint16_t r) {
  switch (r) {
    case 2:
    case 15:
    case 202:
    case 204:
      return "auth/handshake failed (wrong password?)";
    case 200:
      return "lost the AP (beacon timeout)";
    case 201:
      return "AP not found (out of range / 5GHz / SSID typo)";
    case 8:
      return "AP turned us away";
    default:
      return "see reason code";
  }
}

const char* verdict() {
  if (!g_diag.valid) return "No WiFi failure recorded.";
  if (g_diag.associated)
    return "Joined, then dropped — NOT a password problem. Likely weak signal (minimum-RSSI "
           "cutoff) or band-steering. Move closer to an AP, or use a dedicated 2.4GHz SSID.";
  if (authFailed()) return "Failed on auth — wrong password or a WPA-mode mismatch.";
  if (g_diag.reason == 200 || g_diag.reason == 201)
    return "Couldn't reach the AP — out of range, a 5GHz-only SSID (the C3 is 2.4GHz), or a typo.";
  return "Refused before joining — MAC filter, minimum-signal, or band-steering.";
}

void macStr(char* out, size_t n) {
  uint8_t m[6];
  WiFi.macAddress(m);
  snprintf(out, n, "%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
}

// Build the diagnostics panel injected into the captive-portal landing page. Secret-safe: it
// shows the stored password *length*, never the plaintext — a too-short length is the tell that
// a special character (e.g. '#') was truncated before it reached WiFi.begin().
void buildDiagHtml() {
  char mac[18];
  macStr(mac, sizeof(mac));
  g_diagHtml = "<div class='tdiag'><h3>TallyBot diagnostics</h3>";
  if (g_diag.valid) {
    g_diagHtml += "<b>Diagnosis:</b> ";
    g_diagHtml += verdict();
    g_diagHtml += "<br><b>Last failure:</b> ";
    g_diagHtml += reasonText(g_diag.reason);
    g_diagHtml += " (code ";
    g_diagHtml += g_diag.reason;
    g_diagHtml += ")<br><b>RSSI at failure:</b> ";
    g_diagHtml += g_diag.rssi;
    g_diagHtml += " dBm";
  } else {
    g_diagHtml += "No prior WiFi failure recorded.";
  }
  g_diagHtml += "<br><b>Stored SSID:</b> ";
  g_diagHtml += (g_storedSsid[0] ? g_storedSsid : "(none)");
  g_diagHtml += "<br><b>Stored password length:</b> ";
  g_diagHtml += g_wm.getWiFiPass(true).length();
  g_diagHtml += " chars — if shorter than you typed, a special char was truncated.";
  g_diagHtml += "<br><b>Firmware:</b> " FIRMWARE_VERSION " (built " BUILD_TIMESTAMP ")";
  g_diagHtml += "<br><b>MAC:</b> ";
  g_diagHtml += mac;
  g_diagHtml += "</div>";
}

// STA_CONNECTED: association done (4-way handshake → password proven correct). The key signal
// for the "kicked vs never-joined" verdict; fires before STA_GOT_IP.
void onConnected(WiFiEvent_t, WiFiEventInfo_t) { g_associated = true; }

// STA_DISCONNECTED: the only place the granular failure reason is exposed (the library surfaces
// only coarse status). Records this episode's reason for the portal verdict.
void onDisconnected(WiFiEvent_t, WiFiEventInfo_t info) {
  if (g_joinPaused) {  // the scan's own disconnect: not a failure, so the verdict (and FAILED) stand
    g_associated = false;
    TLOG(LOG_LEVEL_INFO, "WiFi join paused: reason=%u\n", info.wifi_sta_disconnected.reason);
    return;
  }
  g_diag.valid = true;
  g_diag.reason = info.wifi_sta_disconnected.reason;
  g_diag.associated = g_associated;
  g_diag.rssi = info.wifi_sta_disconnected.rssi;
  g_associated = false;
  TLOG(LOG_LEVEL_WARN, "WiFi disconnect: reason=%u (%s) assoc=%d rssi=%d\n", g_diag.reason,
       reasonText(g_diag.reason), g_diag.associated, g_diag.rssi);
}

void onPortal(WiFiManager*) {
  TLOG(LOG_LEVEL_INFO, "Config portal up - join \"%s\", then open 192.168.4.1\n", g_apSsid);
  buildDiagHtml();
  g_wm.setCustomMenuHTML(g_diagHtml.c_str());
  ind::setup();  // magenta
}

void beginJoin() {
  g_joinActive = true;
  g_joinStart = millis();
}

// Widen the usable 2.4GHz channels to 1–13 so venue APs on 12/13 are scannable. NB: do NOT use
// esp_wifi_set_country_code("ZA") — the IDF's validated table has no "ZA" and rejects it; the
// older esp_wifi_set_country() takes an explicit channel range and doesn't validate the code.
void setCountry() {
  wifi_country_t c = {};
  memcpy(c.cc, kCountry, sizeof(c.cc));
  c.schan = 1;
  c.nchan = 13;
  c.max_tx_power = 84;  // 21 dBm in 0.25dBm units — don't constrain (we run full power)
  c.policy = WIFI_COUNTRY_POLICY_MANUAL;
  esp_err_t err = esp_wifi_set_country(&c);
  if (err != ESP_OK) TLOG(LOG_LEVEL_WARN, "esp_wifi_set_country failed: 0x%x (channels 12-13 may be off)\n", (unsigned)err);
}
}  // namespace

void wifi::begin(const char* apSsid) {
  strncpy(g_apSsid, apSsid, sizeof(g_apSsid) - 1);
  WiFi.onEvent(onDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.onEvent(onConnected, ARDUINO_EVENT_WIFI_STA_CONNECTED);
  g_wm.setConnectTimeout(kConnectTimeoutS);
  g_wm.setConnectRetries(kConnectRetries);
  g_wm.setCleanConnect(true);  // disconnect before each attempt — clears stale half-handshake state
  g_wm.setAPCallback(onPortal);
  const char* menu[] = {"custom", "wifi", "info", "exit"};
  g_wm.setMenu(menu, 4);  // our diagnostics block first, for zero navigation
  g_wm.setCustomHeadElement(
      "<style>.tdiag{font-family:monospace;font-size:14px;padding:10px;border:1px solid #888;"
      "border-radius:6px;margin:10px 0;background:#f6f6f6;color:#111}</style>");
  buildDiagHtml();
  g_wm.setCustomMenuHTML(g_diagHtml.c_str());
}

void wifi::enableRadio() {
  WiFi.mode(WIFI_STA);
  setCountry();
  // Cache the stored SSID now, while STA is up. Every later read uses this cache, never
  // wm.getWiFiSSID(true) on a possibly-off radio — that read returns uninitialised stack garbage
  // (no WIFI_MODE_NULL guard), which produced a garbled SSID in STATUS after an unplug/replug.
  String stored = g_wm.getWiFiSSID(true);
  strncpy(g_storedSsid, stored.c_str(), sizeof(g_storedSsid) - 1);
  g_storedSsid[sizeof(g_storedSsid) - 1] = '\0';
}

void wifi::disableRadio() { WiFi.mode(WIFI_OFF); }

// STA_START doesn't join (WiFiGeneric.cpp only joins on WiFi.begin), so a No-TX device scans without
// associating. The country goes with it: WIFI_OFF may have dropped it, and without it the scan
// would skip channels 12-13.
bool wifi::scanRadioUp() {
  if (WiFi.getMode() != WIFI_MODE_NULL) return false;
  WiFi.mode(WIFI_STA);
  setCountry();
  return true;
}

// The driver refuses to scan while it is connecting (ESP_ERR_WIFI_STATE), and a join that can't
// associate is connecting almost all the time: Arduino's STA_DISCONNECTED handler (WiFiGeneric.cpp)
// re-runs WiFi.begin() at once while auto-reconnect is on. So the scan pauses such a join: auto-
// reconnect off, then disconnect. The join lifecycle (g_joinActive, g_joinStart) and the last
// failure (g_diag) are untouched, so STATUS keeps reporting the join (JOINING, or FAILED)
// throughout. An associated device is left alone: it can scan.
bool wifi::pauseJoin() {
  if (!(WiFi.getMode() & WIFI_MODE_STA) || connected() || !WiFi.getAutoReconnect() || g_storedSsid[0] == '\0')
    return false;
  g_joinPaused = true;
  WiFi.setAutoReconnect(false);
  WiFi.disconnect();
  return true;
}

// Arduino retries once on the first disconnect since boot whatever auto-reconnect says
// (`first_connect`), so an attempt already in flight when the join was paused can start another.
void wifi::stopJoinAttempt() { WiFi.disconnect(); }

void wifi::resumeJoin() {
  g_joinPaused = false;
  WiFi.setAutoReconnect(true);
  WiFi.begin();  // the creds the driver already holds; non-blocking
}

void wifi::allowReconnect() {
  g_joinPaused = false;
  WiFi.setAutoReconnect(true);
}

bool wifi::espnowRadioUp(uint8_t channel) {
  WiFi.mode(WIFI_STA);
  // No association — ESP-NOW must own a pinned channel, not chase an AP. Auto-reconnect must be
  // off too: a device with saved creds would otherwise silently re-associate behind our back and
  // drag the radio off the pinned channel (beginAssociation() turns it back on when WiFi resumes).
  WiFi.setAutoReconnect(false);
  WiFi.disconnect();
  setCountry();
  WiFi.setTxPower(WIFI_POWER_19_5dBm);  // full power, matching the WiFi path
  esp_err_t err = esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
  if (err != ESP_OK) {
    TLOG(LOG_LEVEL_ERROR, "esp_wifi_set_channel(%u) failed: 0x%x\n", channel, (unsigned)err);
    return false;
  }
  return true;
}

void wifi::dropAssociation() {
  WiFi.setAutoReconnect(false);  // see espnowRadioUp — a re-association would steal the channel
  WiFi.disconnect();
}

bool wifi::connected() { return WiFi.status() == WL_CONNECTED; }

void wifi::connectBlocking() {
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);  // full power, always
  g_wm.setEnableConfigPortal(true);
  bool ok = g_wm.autoConnect(g_apSsid);  // saved creds, else raises the captive portal (blocks)
  TLOG(LOG_LEVEL_INFO, "WiFi %s, IP %s\n", ok ? "connected" : "not connected",
       WiFi.localIP().toString().c_str());
}

// The caller decides what a cancel means: it depends on the transport the device runs.
bool wifi::openPortal() {
  WiFi.mode(WIFI_STA);
  return g_wm.startConfigPortal(g_apSsid);  // always raises the portal (blocks)
}

void wifi::beginAssociation() {
  if (g_storedSsid[0] == '\0') return;  // no creds — don't start a doomed join
  WiFi.persistent(true);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);  // restore the default an ESP-NOW stint turned off
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  WiFi.begin();  // reuse the persisted STA creds — non-blocking
  beginJoin();
}

// SET_WIFI: SAVE-ONLY. Persist the creds (WiFi.begin with persistent(true) writes the exact NVS
// store autoConnect() reads next boot) and let the resulting association run in the background.
// We never wait on or gate confirmation on the join result — the operator must be able to
// provision from anywhere, not only in range of the target AP.
void wifi::provision(const char* ssid, const char* pass) {
  TLOG(LOG_LEVEL_INFO, "SET_WIFI: saving creds for \"%s\" (save-only)\n", ssid);
  WiFi.persistent(true);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  beginJoin();
  strncpy(g_storedSsid, ssid, sizeof(g_storedSsid) - 1);
  g_storedSsid[sizeof(g_storedSsid) - 1] = '\0';
}

bool wifi::serviceDown(unsigned long now) {
  ind::wifiLost();  // amber fast-blink: a network problem (check the AP / range)
  if (g_lostSince == 0) {
    g_lostSince = now;
    TLOG(LOG_LEVEL_WARN, "WiFi lost; waiting for auto-reconnect\n");
    return false;
  }
  if (now - g_lostSince >= kLostPortalMs) {
    g_lostSince = 0;
    return true;  // sustained loss — caller should reprovision
  }
  return false;
}

void wifi::noteUp() { g_lostSince = 0; }
void wifi::cancelJoin() { g_joinActive = false; }

uint8_t wifi::state() {
  if (connected()) return WIFI_STATE_CONNECTED;
  if (!g_joinActive) return WIFI_STATE_IDLE;
  // Report FAILED only for a settled, pre-association auth failure (wrong password / WPA mismatch)
  // past the debounce — never on the C3's spurious first-disconnect transient, and never for
  // out-of-range (so provisioning away from the AP isn't shown as a failure).
  if (authFailed() && millis() - g_joinStart >= kJoinFailMs) return WIFI_STATE_FAILED;
  return WIFI_STATE_JOINING;
}

const char* wifi::ssid() {
  static char buf[33];
  if (WiFi.getMode() == WIFI_MODE_NULL) return "";  // radio off (No-TX): no SSID
  if (connected()) {
    strncpy(buf, WiFi.SSID().c_str(), sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
    return buf;
  }
  return g_storedSsid;  // cached stored name (joining / not yet up)
}

int8_t wifi::rssi() { return connected() ? (int8_t)WiFi.RSSI() : 0; }

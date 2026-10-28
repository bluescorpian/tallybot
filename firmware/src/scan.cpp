#include "scan.h"

#include <Arduino.h>
#include <WiFi.h>
#include <atomic>
#include <esp_wifi.h>
#include <string.h>

#include "espnow.h"
#include "log.h"
#include "protocol.h"
#include "usb.h"
#include "wifi.h"

namespace {
// Active scan, this long on each of the 13 channels: ≈1.6 s off a bridge's channel, inside the
// spec's ≈2 s budget and well under a light's HOST_SILENCE_TIMEOUT_MS.
constexpr uint32_t kChannelMs = 120;
// Give up on a scan that hasn't finished by then (from the SCAN_WIFI): the host's own timeout reads
// the silence as a failure. Nearly twice a normal sweep, and bounded by a light's link (below).
constexpr unsigned long kScanTimeoutMs = 3000;
// Give up sending SCAN_RESULTs a host isn't reading.
constexpr unsigned long kEmitTimeoutMs = 3000;
// After esp_wifi_scan_stop, how long to wait for the scan to end (SCAN_DONE, or on a bridge the
// radio accepting its channel again): nothing documents that the stop is synchronous.
constexpr unsigned long kStopSettleMs = 500;
// A light hears its bridge only through the sidecar's keyframes (REFRESH_PERIOD_MS, app.ts): its last
// one can come a period before the bridge leaves its channel, and the next a period after it returns.
constexpr unsigned long kKeyframeMs = 250;
constexpr unsigned long kLinkMarginMs = 500;  // event latency, a lost keyframe, clock drift
// A bridge is off its channel for at most kScanTimeoutMs + kStopSettleMs, and its lights must not
// time out over that. The same bound keeps the radio phases inside the USB session timeout, so a
// host vanishing (the SCAN_WIFI restarted that timer) can't tear the radio down mid-scan.
static_assert(kScanTimeoutMs + kStopSettleMs + 2 * kKeyframeMs + kLinkMarginMs <= HOST_SILENCE_TIMEOUT_MS,
              "a bridge's worst-case time off its channel would let its lights' links time out");
constexpr unsigned long kStopRetryMs = 50;  // a bridge's quiet re-pin attempts while stopping
// While STARTING with the join paused, how often to repeat the pause's disconnect.
constexpr unsigned long kJoinKickMs = 500;
// A sweep can't end sooner than kChannelMs on each channel; a SCAN_DONE this early is the late one
// of a scan stopped before (see g_staleOwed). Half the sweep, so a short country list still clears it.
constexpr unsigned long kMinSweepMs = (ESPNOW_CHANNEL_MAX - ESPNOW_CHANNEL_MIN + 1) * kChannelMs / 2;
constexpr size_t kMaxResultBytes = 6 + 32;  // SCAN_RESULT head + the longest SSID
// Free TX space left after a SCAN_RESULT, for a RELAY-up, STATUS or LOG sent in the same tick.
constexpr size_t kTxHeadroom = 64;
constexpr uint16_t kMaxResults = 255;        // index/total are single bytes

enum class Phase {
  IDLE,
  STARTING,  // the driver refused to start (a WiFi join in progress); retried each tick
  SCANNING,  // the driver is sweeping channels
  STOPPING,  // the scan was stopped (timeout); waiting for the driver to let go before the hand-back
  SENDING,   // the radio is back; SCAN_RESULTs go out as the USB TX buffer has room
};
Phase g_phase = Phase::IDLE;
unsigned long g_phaseStart = 0;  // the SCAN_WIFI (STARTING/SCANNING), the stop (STOPPING) or the first frame (SENDING)
unsigned long g_scanStart = 0;   // the driver accepted the scan
esp_err_t g_startErr = ESP_OK;   // the driver's last refusal, for the give-up line
bool g_radioWasOff = false;      // the scan switched STA on (No-TX), so it switches it off after
bool g_joinPaused = false;       // the scan paused a join the driver reported connecting, so it resumes it after
bool g_retried = false;          // a failed sweep has been retried once (a connect may have aborted it)
unsigned long g_lastKick = 0;    // STARTING: the last stopJoinAttempt
unsigned long g_lastRepin = 0;   // STOPPING: the last quiet re-pin attempt
// A stopped scan whose SCAN_DONE never came may still deliver it, into the next scan: that one then
// ignores a SCAN_DONE earlier than kMinSweepMs. The event's scan_id can't settle it: the driver
// doesn't say which id a scan it starts gets (esp_wifi.h; the field is "used for block scan").
bool g_staleOwed = false;
uint16_t g_total = 0;            // results to send (0: the empty frame)
uint16_t g_next = 0;             // the next index to send

// Set from the Arduino event task, after its own SCAN_DONE handler (WiFiScanClass::_scanDone, run
// first in WiFiGenericClass::_eventCallback) has copied the driver's AP records into the buffer
// WiFi.getScanInfoByIndex reads.
std::atomic<bool> g_done{false};
std::atomic<bool> g_doneOk{false};

std::atomic<uint8_t> g_doneId{0};  // logged only: hardware evidence for how scan_id behaves

void onScanDone(WiFiEvent_t, WiFiEventInfo_t info) {
  g_doneOk.store(info.wifi_scan_done.status == 0);  // 0 success, 1 failure (esp_wifi_types.h)
  g_doneId.store(info.wifi_scan_done.scan_id);
  g_done.store(true);
}

esp_err_t startDriverScan() {
  WiFi.scanDelete();  // free the previous scan's records
  // Not WiFi.scanNetworks: it leaves home_chan_dwell_time uninitialised (WiFiScan.cpp) and hardwires
  // the active-scan minimum. Value-initialised here, so that field is 0. Channel 0 is every channel
  // the country allows (wifi.cpp sets ZA, 1–13); hidden APs are kept, as they occupy a channel too.
  wifi_scan_config_t cfg = {};
  cfg.show_hidden = true;
  cfg.scan_type = WIFI_SCAN_TYPE_ACTIVE;
  cfg.scan_time.active.min = kChannelMs;
  cfg.scan_time.active.max = kChannelMs;
  g_done.store(false);
  return esp_wifi_scan_start(&cfg, false);
}

void tryStart() {
  g_startErr = startDriverScan();
  if (g_startErr == ESP_OK) {
    g_phase = Phase::SCANNING;
    g_scanStart = millis();
    TLOG(LOG_LEVEL_INFO, "SCAN_WIFI: scanning channels %u-%u\n", ESPNOW_CHANNEL_MIN, ESPNOW_CHANNEL_MAX);
    return;
  }
  g_phase = Phase::STARTING;  // retried each tick, whatever the refusal
  if (g_startErr != ESP_ERR_WIFI_STATE) return;
  // "Still connecting" (esp_wifi.h): pause the join the driver reports in flight, and only that one.
  if (!g_joinPaused) {
    g_joinPaused = wifi::pauseJoin();
    if (g_joinPaused) TLOG(LOG_LEVEL_INFO, "SCAN_WIFI: WiFi join paused for the scan\n");
    g_lastKick = millis();
  } else if (millis() - g_lastKick >= kJoinKickMs) {
    g_lastKick = millis();
    wifi::stopJoinAttempt();
  }
}

// Hand the radio back the way the scan found it, except a bridge's channel: off again for No-TX, and
// a paused join resumed.
void restoreRadio() {
  if (g_radioWasOff) wifi::disableRadio();
  if (g_joinPaused) wifi::resumeJoin();
  g_radioWasOff = false;
  g_joinPaused = false;
}

// The scan has ended: restore the radio and put a bridge back on its channel (the driver leaves it
// wherever the sweep ended), leaving bridge mode if the radio refuses.
void releaseRadio() {
  restoreRadio();
  espnow::repinBridge(true);
}

void finish() {
  WiFi.scanDelete();
  g_phase = Phase::IDLE;
}

void sendNext() {
  uint8_t frame[kMaxResultBytes];
  if (g_total == 0) {
    usb::send(frame, encodeEmptyScanResultPayload(frame));
    TLOG(LOG_LEVEL_INFO, "SCAN_WIFI: no access points heard\n");
    finish();
    return;
  }
  auto* ap = static_cast<const wifi_ap_record_t*>(WiFi.getScanInfoByIndex(g_next));
  if (!ap) {  // the records went (another scan replaced them); the host times out on the gap
    TLOG(LOG_LEVEL_WARN, "SCAN_WIFI: result %u of %u gone; stopping\n", g_next, g_total);
    finish();
    return;
  }
  const char* ssid = reinterpret_cast<const char*>(ap->ssid);
  usb::send(frame, encodeScanResultPayload(frame, (uint8_t)g_next, (uint8_t)g_total, ap->primary, ap->rssi,
                                           ssid, (uint8_t)strnlen(ssid, 32)));
  if (++g_next < g_total) return;
  TLOG(LOG_LEVEL_INFO, "SCAN_WIFI: sent %u access points\n", g_total);
  finish();
}
}  // namespace

void scan::begin() { WiFi.onEvent(onScanDone, ARDUINO_EVENT_WIFI_SCAN_DONE); }

void scan::request() {
  if (g_phase != Phase::IDLE) {
    TLOG(LOG_LEVEL_INFO, "SCAN_WIFI ignored: a scan is already running\n");
    return;
  }
  g_radioWasOff = wifi::scanRadioUp();
  g_joinPaused = false;
  g_retried = false;
  g_phaseStart = millis();
  tryStart();
}

bool scan::active() { return g_phase != Phase::IDLE; }

bool scan::radioBusy() {
  return g_phase == Phase::STARTING || g_phase == Phase::SCANNING || g_phase == Phase::STOPPING;
}

void scan::abort() {
  if (g_phase == Phase::IDLE) return;
  if (g_phase == Phase::SCANNING) {
    esp_wifi_scan_stop();
    g_staleOwed = true;  // not waited for: the new owner takes the radio now
  } else if (g_phase == Phase::STOPPING && !g_done.load()) {
    g_staleOwed = true;
  }
  TLOG(LOG_LEVEL_WARN, "SCAN_WIFI abandoned: the radio is wanted elsewhere\n");
  // The new owner configures the radio; a paused join only gets auto-reconnect back, since that
  // owner starts its own join (or portal) and a WiFi.begin() here would leave the driver connecting.
  if (g_joinPaused) wifi::allowReconnect();
  g_radioWasOff = false;
  g_joinPaused = false;
  finish();
}

// millis(), not the loop's `now`: request() stamps g_phaseStart from inside usb::loop's RX pump,
// possibly after the loop-top `now`, and the unsigned subtraction would wrap.
void scan::loop() {
  switch (g_phase) {
    case Phase::IDLE:
      return;
    case Phase::STARTING:
      if (millis() - g_phaseStart >= kScanTimeoutMs) {
        TLOG(LOG_LEVEL_ERROR, "SCAN_WIFI: the driver wouldn't start a scan (0x%x)\n", (unsigned)g_startErr);
        releaseRadio();
        finish();
        return;
      }
      tryStart();
      return;
    case Phase::SCANNING: {
      if (g_done.load() && g_staleOwed) {
        g_staleOwed = false;
        if (millis() - g_scanStart < kMinSweepMs) {
          TLOG(LOG_LEVEL_WARN, "SCAN_WIFI: ignored a stale scan-done (id %u)\n", g_doneId.load());
          g_done.store(false);
          WiFi.scanDelete();  // the records Arduino copied for it
          return;
        }
      }
      if (!g_done.load()) {
        if (millis() - g_phaseStart < kScanTimeoutMs) return;
        esp_wifi_scan_stop();
        TLOG(LOG_LEVEL_ERROR, "SCAN_WIFI: no result in %lums; stopped\n", kScanTimeoutMs);
        g_phase = Phase::STOPPING;
        g_phaseStart = millis();
        g_lastRepin = millis();
        return;
      }
      TLOG(LOG_LEVEL_INFO, "SCAN_WIFI: scan done (id %u)\n", g_doneId.load());
      int16_t count = WiFi.scanComplete();  // the records _scanDone copied (negative: none kept)
      bool failed = !g_doneOk.load() || count < 0;
      // A connect the scan didn't pause (a retry Arduino fired in the moment the driver was idle, so
      // the scan started) aborts the sweep (esp_wifi.h). Once, within the bound: the restart sees the
      // connect and pauses it.
      if (failed && !g_retried && millis() - g_phaseStart < kScanTimeoutMs) {
        g_retried = true;
        TLOG(LOG_LEVEL_WARN, "SCAN_WIFI: the scan failed; retrying\n");
        tryStart();
        return;
      }
      releaseRadio();
      if (failed) {
        TLOG(LOG_LEVEL_ERROR, "SCAN_WIFI: the scan failed\n");
        finish();
        return;
      }
      g_total = count > kMaxResults ? kMaxResults : (uint16_t)count;
      g_next = 0;
      g_phase = Phase::SENDING;
      g_phaseStart = millis();
      return;
    }
    case Phase::STOPPING:
      // The scan already failed (nothing is sent); this only waits for the driver to let go, so the
      // hand-back isn't refused. On a bridge the radio accepting its channel is that sign too.
      if (g_done.load()) {
        releaseRadio();
      } else if (millis() - g_phaseStart >= kStopSettleMs) {
        g_staleOwed = true;
        TLOG(LOG_LEVEL_WARN, "SCAN_WIFI: no scan-done %lums after the stop\n", kStopSettleMs);
        releaseRadio();
      } else if (espnow::bridgeActive() && millis() - g_lastRepin >= kStopRetryMs) {
        g_lastRepin = millis();
        if (!espnow::repinBridge(false)) return;
        restoreRadio();
      } else {
        return;
      }
      finish();
      return;
    case Phase::SENDING:
      // One frame per tick, and only into room: usb::send never blocks, so a frame written into a
      // full TX buffer would be cut short.
      if (millis() - g_phaseStart >= kEmitTimeoutMs) {
        TLOG(LOG_LEVEL_WARN, "SCAN_WIFI: host not reading; stopped at %u of %u\n", g_next, g_total);
        finish();
        return;
      }
      if (usb::txRoom(kMaxResultBytes + kTxHeadroom)) sendNext();
      return;
  }
}

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
// the silence as a failure. Shorter than the USB session timeout, so the host vanishing can't tear
// the radio down mid-scan (the SCAN_WIFI itself restarts that timer).
constexpr unsigned long kScanTimeoutMs = 4000;
static_assert(kScanTimeoutMs < HOST_SILENCE_TIMEOUT_MS, "a scan must end before the USB session can time out");
// Give up sending SCAN_RESULTs a host isn't reading.
constexpr unsigned long kEmitTimeoutMs = 3000;
constexpr size_t kMaxResultBytes = 6 + 32;  // SCAN_RESULT head + the longest SSID
constexpr uint16_t kMaxResults = 255;        // index/total are single bytes

enum class Phase {
  IDLE,
  STARTING,  // the driver refused to start (a WiFi join in progress); retried each tick
  SCANNING,  // the driver is sweeping channels
  SENDING,   // the radio is back; SCAN_RESULTs go out as the USB TX buffer has room
};
Phase g_phase = Phase::IDLE;
unsigned long g_phaseStart = 0;  // the SCAN_WIFI (STARTING/SCANNING) or the first frame (SENDING)
esp_err_t g_startErr = ESP_OK;   // the driver's last refusal, for the give-up line
bool g_radioWasOff = false;      // the scan switched STA on (No-TX), so it switches it off after
uint16_t g_total = 0;            // results to send (0: the empty frame)
uint16_t g_next = 0;             // the next index to send

// Set from the Arduino event task, after its own SCAN_DONE handler (WiFiScanClass::_scanDone, run
// first in WiFiGenericClass::_eventCallback) has copied the driver's AP records into the buffer
// WiFi.getScanInfoByIndex reads.
std::atomic<bool> g_done{false};
std::atomic<bool> g_doneOk{false};

void onScanDone(WiFiEvent_t, WiFiEventInfo_t info) {
  g_doneOk.store(info.wifi_scan_done.status == 0);  // 0 success, 1 failure (esp_wifi_types.h)
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
    TLOG(LOG_LEVEL_INFO, "SCAN_WIFI: scanning channels %u-%u\n", ESPNOW_CHANNEL_MIN, ESPNOW_CHANNEL_MAX);
  } else {
    g_phase = Phase::STARTING;  // ESP_ERR_WIFI_STATE while a join is in progress; others retry too
  }
}

// Hand the radio back the way the scan found it: off again for No-TX, and a bridge back on its
// channel (the driver leaves it wherever the sweep ended).
void releaseRadio() {
  if (g_radioWasOff) {
    wifi::disableRadio();
    g_radioWasOff = false;
  }
  espnow::repinBridge();
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
  g_phaseStart = millis();
  tryStart();
}

bool scan::radioBusy() { return g_phase == Phase::STARTING || g_phase == Phase::SCANNING; }

void scan::abort() {
  if (g_phase == Phase::IDLE) return;
  if (g_phase == Phase::SCANNING) esp_wifi_scan_stop();
  TLOG(LOG_LEVEL_WARN, "SCAN_WIFI abandoned: the radio is wanted elsewhere\n");
  g_radioWasOff = false;  // the new owner configures the radio
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
      if (!g_done.load()) {
        if (millis() - g_phaseStart < kScanTimeoutMs) return;
        esp_wifi_scan_stop();
        TLOG(LOG_LEVEL_ERROR, "SCAN_WIFI: no result in %lums; stopped\n", kScanTimeoutMs);
        releaseRadio();
        finish();
        return;
      }
      releaseRadio();
      int16_t count = WiFi.scanComplete();  // the records _scanDone copied (negative: none kept)
      if (!g_doneOk.load() || count < 0) {
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
    case Phase::SENDING:
      // One frame per tick, and only into room: usb::send never blocks, so a frame written into a
      // full TX buffer would be cut short.
      if (millis() - g_phaseStart >= kEmitTimeoutMs) {
        TLOG(LOG_LEVEL_WARN, "SCAN_WIFI: host not reading; stopped at %u of %u\n", g_next, g_total);
        finish();
        return;
      }
      if (usb::txRoom(kMaxResultBytes)) sendNext();
      return;
  }
}

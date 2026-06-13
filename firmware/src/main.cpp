// TallyBot firmware — the tally-light client for the ESP32-C3 SuperMini.
//
// A TCP client (see ARCHITECTURE.md): it provisions WiFi via a captive portal, discovers the
// sidecar over UDP, opens a TCP connection, sends HELLO then HEARTBEATs, and drives the onboard
// WS2812 from the server's SET_COLOR. A USB-CDC control channel (v1.2) carries the same payloads
// while cabled, plus provisioning (SET_WIFI / SET_TRANSPORT) and STATUS.
//
// Board facts this firmware respects (CLAUDE.md): GPIO8 is an addressable WS2812 (FastLED only);
// never sleep (the loop stays busy so a power bank's auto-off can't cut power); Serial reaches
// USB only with ARDUINO_USB_CDC_ON_BOOT (platformio.ini).
//
// This file is just the orchestrator — init order, the USB-first-boot decision, and the per-tick
// service calls. The work lives in the modules: led, wifi, usb, tally, control, settings.

#include <Arduino.h>
#include <WiFi.h>

#include "control.h"
#include "espnow.h"
#include "indicators.h"
#include "led.h"
#include "log.h"
#include "protocol.h"
#include "settings.h"
#include "tally.h"
#include "usb.h"
#include "wifi.h"

namespace {
constexpr uint8_t kBootButtonPin = 9;  // on-board BOOT (active-low); hold to re-open WiFi setup
constexpr unsigned long kReprovisionHoldMs = 3000;
// USB-first boot: a WiFi-mode device gives a USB host this long to claim it (reply to our HELLO)
// before starting the blocking WiFi join — "while plugged in, communicate over USB regardless of
// provisioned mode." Sized for the host's worst-case detect+reply latency, not ours.
constexpr unsigned long kUsbBootGraceMs = 4000;

// What the device is doing right now.
//   USB_DECIDING  — cabled WiFi device, waiting to see if a host claims it (USB-first boot)
//   USB_OWNED     — a host won the cable; tally flows over USB, the radio is kept warm
//   WIFI_CLIENT   — running the WiFi discovery/TCP tally client
//   ESPNOW_CLIENT — running the ESP-NOW light (discovery → link → render), gated off while a host owns USB
//   NOTX          — wired-only device; radio off, USB or local steady-blue only
enum class Mode { USB_DECIDING, USB_OWNED, WIFI_CLIENT, ESPNOW_CLIENT, NOTX };
Mode g_mode;

bool g_espnowGated = false;  // ESPNOW_CLIENT only: the light is stopped because a USB host owns the cable

uint8_t g_mac[6];
char g_apSsid[24];          // "TallyLight-XXXXXX"
unsigned long g_bootStart = 0;
unsigned long g_btnDownSince = 0;
bool g_wifiUp = false;      // last-seen WiFi link state, to detect up/down edges

void onMessage(const ServerMessage& msg) { control::dispatch(msg); }

// Run the blocking WiFi bring-up (saved creds → captive portal), then start the tally client.
void startWifiClient() {
  wifi::connectBlocking();
  tally::start();
  g_wifiUp = wifi::connected();
  g_mode = Mode::WIFI_CLIENT;
}

// Hold BOOT for kReprovisionHoldMs to re-open the captive portal (switch networks) in any state.
void checkBootButton(unsigned long now) {
  if (digitalRead(kBootButtonPin) != LOW) {  // active-low: released
    g_btnDownSince = 0;
    return;
  }
  if (g_btnDownSince == 0) {
    g_btnDownSince = now;
  } else if (now - g_btnDownSince >= kReprovisionHoldMs) {
    g_btnDownSince = 0;
    TLOG(LOG_LEVEL_INFO, "BOOT held - opening WiFi setup\n");
    usb::resetSession();
    tally::stop();
    wifi::openPortal();  // blocks until reconfigured or cancelled
    tally::start();
    g_wifiUp = wifi::connected();
    g_mode = Mode::WIFI_CLIENT;
  }
}

// ESP-NOW light, with the "USB wins" gate: while a host owns the cable, tally comes from USB, so
// the light's ESP-NOW client is stopped (no discovery broadcasts) — mirroring how the WiFi tally
// client is gated off in USB_OWNED. Session end is the sessionLost edge (host silent past the
// timeout), NOT !hostPresent(): g_hostSeen is sticky until resetSession(), so reading it as the
// un-gate condition would leave a once-cabled light stopped forever after unplug.
void serviceEspnowClient(unsigned long now) {
  if (usb::hostPresent() && !g_espnowGated) {
    g_espnowGated = true;
    espnow::stopLight();  // USB drives tally now; local indicators step aside via suppressLocal
    TLOG(LOG_LEVEL_INFO, "USB host detected; ESP-NOW light gated off\n");
  } else if (g_espnowGated && usb::sessionLost()) {
    usb::resetSession();  // clears g_hostSeen so a replugged host re-gates cleanly
    g_espnowGated = false;
    espnow::startLight();  // session ended — resume discovery
    TLOG(LOG_LEVEL_INFO, "USB host lost; resuming ESP-NOW light\n");
  }
  if (!g_espnowGated) espnow::loopLight(now);
}

void serviceWifiClient(unsigned long now) {
  if (!wifi::connected()) {
    if (g_wifiUp) {  // down edge
      g_wifiUp = false;
      tally::stop();
    }
    if (wifi::serviceDown(now)) {  // sustained loss → retry + portal
      wifi::connectBlocking();
      tally::start();
      g_wifiUp = wifi::connected();
    }
    return;
  }
  if (!g_wifiUp) {  // up edge: (re)bind discovery and start hunting
    g_wifiUp = true;
    wifi::noteUp();
    tally::start();
    TLOG(LOG_LEVEL_INFO, "WiFi up, IP %s\n", WiFi.localIP().toString().c_str());
  }
  tally::loop(now);
}
}  // namespace

void setup() {
  Serial.begin(115200);
  // Bounded wait for USB-CDC to enumerate (not `while (!Serial)`): a headless device on a power
  // bank has no host attached and must never block here.
  unsigned long start = millis();
  while (!Serial && millis() - start < 2000) delay(10);

  WiFi.macAddress(g_mac);
  snprintf(g_apSsid, sizeof(g_apSsid), "TallyLight-%02X%02X%02X", g_mac[3], g_mac[4], g_mac[5]);

  led::begin();
  usb::begin(g_mac, onMessage);  // COBS channel up before any TLOG (release builds frame logs)
  settings::begin();
  tally::init(g_mac, onMessage);
  espnow::init(g_mac, onMessage);
  wifi::begin(g_apSsid);

  TLOG(LOG_LEVEL_INFO, "=== TallyBot === AP %s\n", g_apSsid);
  pinMode(kBootButtonPin, INPUT_PULLUP);
  led::bootSelfTest();  // R→G→B→W — prove the LED works before anything network-related

  switch (settings::transportMode()) {
    case TRANSPORT_WIFI:
      wifi::enableRadio();       // STA + channel widening + cache the stored SSID
      wifi::beginAssociation();  // non-blocking warm join (if provisioned), kept warm for USB-first
      ind::joiningWifi();        // amber pulse during the grace window
      g_mode = Mode::USB_DECIDING;
      g_bootStart = millis();
      break;
    case TRANSPORT_ESPNOW:
      espnow::startLight();  // radio up as a light + begin discovery (ind::searching, cyan)
      g_mode = Mode::ESPNOW_CLIENT;
      TLOG(LOG_LEVEL_INFO, "ESP-NOW mode: discovering a bridge\n");
      break;
    default:  // TRANSPORT_NOTX
      wifi::disableRadio();
      ind::lostServer();  // steady blue: USB-only until the app connects over USB
      g_mode = Mode::NOTX;
      TLOG(LOG_LEVEL_INFO, "No-TX mode: WiFi off, USB only\n");
      break;
  }
}

void loop() {
  unsigned long now = millis();

  bool usbTallyReleased = usb::loop(now);  // pump RX, re-announce HELLO, release idle tally
  control::maybeEmitStatus(now);           // stream STATUS on change while a host is cabled
  checkBootButton(now);                    // hold BOOT → re-open WiFi setup

  // Bridge mode is runtime + transport-agnostic: while active it owns the radio (relaying
  // host↔light), so the per-mode client below stays suppressed. The host vanishing (port closed)
  // tears it down, the same session-end cue that reverts a USB-owned WiFi device.
  if (espnow::bridgeActive()) {
    espnow::loopBridge();
    if (usb::sessionLost()) {
      TLOG(LOG_LEVEL_INFO, "USB host lost; leaving bridge mode\n");
      usb::resetSession();
      espnow::exitBridge();  // tears the bridge radio down + restores it per NVS (WiFi/No-TX)
      // Resume the device's own transport client. exitBridge already rebuilt the WiFi/No-TX radio;
      // here we re-establish g_mode + restart the matching client without a reboot (the device
      // must keep rendering through designation changes).
      switch (settings::transportMode()) {
        case TRANSPORT_WIFI:
          tally::start();  // radio re-enabled by exitBridge; (re)bind discovery
          g_wifiUp = wifi::connected();
          g_mode = Mode::WIFI_CLIENT;
          break;
        case TRANSPORT_ESPNOW:
          espnow::startLight();  // exitBridge left the radio down for the light to own
          g_espnowGated = false;
          g_mode = Mode::ESPNOW_CLIENT;
          break;
        default:  // TRANSPORT_NOTX
          ind::lostServer();
          g_mode = Mode::NOTX;
          break;
      }
    } else {
      led::render(now);
      delay(1);
      return;
    }
  }

  switch (g_mode) {
    case Mode::USB_DECIDING:
      if (usb::hostPresent()) {
        g_mode = Mode::USB_OWNED;  // a host claimed the cable; tally over USB, radio stays warm
        TLOG(LOG_LEVEL_INFO, "USB host detected; USB owns tally\n");
      } else if (now - g_bootStart >= kUsbBootGraceMs) {
        TLOG(LOG_LEVEL_INFO, "No USB host in %lums; starting WiFi\n", kUsbBootGraceMs);
        startWifiClient();
      }
      break;

    case Mode::USB_OWNED:
      // The host fell silent (likely unplugged but still powered) — hand the device back to WiFi.
      if (usbTallyReleased) {
        TLOG(LOG_LEVEL_INFO, "USB host lost; reverting to WiFi\n");
        usb::resetSession();
        if (wifi::connected()) {  // warm association already up — straight to discovery
          tally::start();
          g_wifiUp = true;
          g_mode = Mode::WIFI_CLIENT;
        } else {  // not associated (creds missing / out of range) — full bring-up
          startWifiClient();
        }
      }
      break;

    case Mode::WIFI_CLIENT:
      serviceWifiClient(now);
      break;

    case Mode::ESPNOW_CLIENT:
      serviceEspnowClient(now);
      break;

    case Mode::NOTX:
      break;
  }

  led::render(now);
  delay(1);  // yield to the WiFi stack / feed the watchdog — not a sleep
}

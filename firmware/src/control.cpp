#include "control.h"

#include <Arduino.h>
#include <string.h>

#include "espnow.h"
#include "led.h"
#include "log.h"
#include "scan.h"
#include "settings.h"
#include "usb.h"
#include "wifi.h"

namespace {
constexpr unsigned long kEmitIntervalMs = 500;  // change-detector tick while a host is cabled
constexpr int kRssiDeltaDbm = 5;                 // RSSI move that counts as a reportable change

// Everything STATUS reports. A new field goes here, in statusSnapshot(), in sameStatus() and in the
// encoder call in emit().
struct Snapshot {
  uint8_t transport = 0;
  uint8_t wifiState = 0;
  int8_t rssi = 0;
  char ssid[33] = {0};
  uint8_t channel = 0;  // the device's stored ESP-NOW channel (default 1)
  bool bridge = false;
};

Snapshot statusSnapshot() {
  Snapshot s;
  s.transport = settings::transportMode();
  s.wifiState = wifi::state();
  s.rssi = wifi::rssi();
  strncpy(s.ssid, wifi::ssid(), sizeof(s.ssid) - 1);
  s.channel = settings::espnowChannel();
  s.bridge = espnow::bridgeActive();
  return s;
}

// Equal for reporting purposes: RSSI jitter under kRssiDeltaDbm is not a change.
bool sameStatus(const Snapshot& a, const Snapshot& b) {
  return a.transport == b.transport && a.wifiState == b.wifiState &&
         abs((int)a.rssi - (int)b.rssi) < kRssiDeltaDbm && strcmp(a.ssid, b.ssid) == 0 &&
         a.channel == b.channel && a.bridge == b.bridge;
}

bool g_haveLast = false;
Snapshot g_last;  // the last STATUS sent, for the change detector
unsigned long g_lastEmit = 0;

void emit(const Snapshot& s) {
  uint8_t payload[39];  // 4-byte head + 1-byte len + up to 32 SSID bytes + channel + bridging
  usb::send(payload, encodeStatusPayload(payload, s.transport, s.wifiState, s.rssi, s.ssid,
                                         (uint8_t)strlen(s.ssid), s.channel, s.bridge ? 1 : 0));
  g_last = s;
  g_haveLast = true;
}

// The last SET_COLOR colour logged. The server re-asserts the current colour every keyframe (4 Hz)
// and streams breathe frames at 10 Hz with a new brightness each, so only an RGB change is logged:
// one line per state change, not one per frame.
struct Rendered {
  bool valid = false;
  uint8_t r = 0, g = 0, b = 0;
};
Rendered g_rendered;

// SET_BRIDGE and SET_WIFI reconfigure the radio, which must not happen while the driver scans (a
// retune mid-scan is refused, a join is cut short), so they wait for it. Each carries the whole
// setting, so only the latest of each kind is kept, in arrival order.
ServerMessage g_deferred[2];
size_t g_deferredCount = 0;

bool deferWhileScanning(const ServerMessage& msg) {
  if (!scan::radioBusy() || (msg.kind != ServerMessage::SET_BRIDGE && msg.kind != ServerMessage::SET_WIFI))
    return false;
  for (size_t i = 0; i < g_deferredCount; i++) {
    if (g_deferred[i].kind != msg.kind) continue;
    for (size_t j = i + 1; j < g_deferredCount; j++) g_deferred[j - 1] = g_deferred[j];
    g_deferredCount--;
    break;
  }
  g_deferred[g_deferredCount++] = msg;
  TLOG(LOG_LEVEL_INFO, "%s held until the scan finishes\n",
       msg.kind == ServerMessage::SET_BRIDGE ? "SET_BRIDGE" : "SET_WIFI");
  return true;
}
}  // namespace

void control::dispatch(const ServerMessage& msg) {
  if (deferWhileScanning(msg)) return;
  switch (msg.kind) {
    case ServerMessage::SET_COLOR:
      led::setTally(msg.r, msg.g, msg.b, msg.brightness, led::STEADY);
      if (!g_rendered.valid || msg.r != g_rendered.r || msg.g != g_rendered.g || msg.b != g_rendered.b) {
        g_rendered.valid = true;
        g_rendered.r = msg.r;
        g_rendered.g = msg.g;
        g_rendered.b = msg.b;
        TLOG(LOG_LEVEL_INFO, "SET_COLOR rgb(%u,%u,%u) bri=%u\n", msg.r, msg.g, msg.b, msg.brightness);
      }
      break;
    case ServerMessage::SET_WIFI:
      wifi::provision(msg.ssid, msg.pass);
      settings::setTransportMode(TRANSPORT_WIFI);  // provisioning implies "use WiFi when unplugged"
      emitStatus();
      break;
    case ServerMessage::SET_TRANSPORT:
      // A channel the radio can't tune would leave the light failing radio-up on every retry, so
      // the whole command is refused (nothing half-applied); the unchanged STATUS tells the host.
      if (msg.transportMode == TRANSPORT_ESPNOW && msg.hasChannel && !isEspnowChannel(msg.channel)) {
        TLOG(LOG_LEVEL_WARN, "SET_TRANSPORT ignored: channel %u out of range (%u-%u)\n", msg.channel,
             ESPNOW_CHANNEL_MIN, ESPNOW_CHANNEL_MAX);
        emitStatus();
        break;
      }
      settings::setTransportMode(msg.transportMode);
      if (msg.transportMode == TRANSPORT_NOTX) wifi::cancelJoin();  // No-TX has no join lifecycle
      // ESP-NOW carries an optional channel; persist it when present (absent ⇒ keep stored/default).
      if (msg.transportMode == TRANSPORT_ESPNOW && msg.hasChannel)
        settings::setEspnowChannel(msg.channel);
      TLOG(LOG_LEVEL_INFO, "SET_TRANSPORT: %s (applies next boot)\n",
           msg.transportMode == TRANSPORT_NOTX
               ? "No-TX"
               : (msg.transportMode == TRANSPORT_ESPNOW ? "ESP-NOW" : "WiFi"));
      emitStatus();
      break;
    case ServerMessage::GET_STATUS:
      // HELLO first: GET_STATUS doubles as the host's identity probe. The unsolicited HELLO
      // re-announce stops on the first host frame (g_hostSeen is sticky), so a host that
      // reopens the port mid-session would otherwise never learn the MAC — it probes with
      // GET_STATUS on open and this reply re-identifies the device. Mid-session the extra
      // HELLO is benign (the shell ignores re-HELLOs once the MAC is known).
      usb::sendHello();
      emitStatus();
      break;
    case ServerMessage::SET_BRIDGE:
      if (msg.bridgeEnabled)
        espnow::enterBridge(msg.channel, msg.txPower);  // runtime-only; txPower is full when absent
      else
        espnow::exitBridge();
      emitStatus();  // the STATUS trailing bytes confirm the mode took effect
      break;
    case ServerMessage::RELAY:
      espnow::relay(msg);  // strip header → esp_now_send(targetMAC, inner); dropped if no such peer
      break;
    case ServerMessage::SCAN_WIFI:  // USB only (dispatchUsb): over TCP or inside a RELAY it's ignored
    case ServerMessage::UNKNOWN:
      break;
  }
}

void control::dispatchUsb(const ServerMessage& msg) {
  if (msg.kind == ServerMessage::SCAN_WIFI)
    scan::request();
  else
    dispatch(msg);
}

void control::runDeferred() {
  if (g_deferredCount == 0 || scan::radioBusy()) return;
  ServerMessage pending[2];
  size_t n = g_deferredCount;
  for (size_t i = 0; i < n; i++) pending[i] = g_deferred[i];
  g_deferredCount = 0;
  for (size_t i = 0; i < n; i++) dispatch(pending[i]);
}

void control::emitStatus() { emit(statusSnapshot()); }

void control::maybeEmitStatus(unsigned long now) {
  if (now - g_lastEmit < kEmitIntervalMs) return;
  g_lastEmit = now;
  if (!usb::hostPresent()) return;  // no host listening — don't stream into the void
  Snapshot current = statusSnapshot();
  if (g_haveLast && sameStatus(current, g_last)) return;
  emit(current);
}

#include "control.h"

#include <Arduino.h>
#include <string.h>

#include "espnow.h"
#include "led.h"
#include "log.h"
#include "settings.h"
#include "usb.h"
#include "wifi.h"

namespace {
constexpr unsigned long kEmitIntervalMs = 500;  // change-detector tick while a host is cabled
constexpr int kRssiDeltaDbm = 5;                 // RSSI move that counts as a reportable change

struct Snapshot {
  bool valid = false;
  uint8_t transport = 0;
  uint8_t wifiState = 0;
  int8_t rssi = 0;
  char ssid[33] = {0};
  uint8_t channel = 0;
  bool bridge = false;
};
Snapshot g_last;
unsigned long g_lastEmit = 0;
}  // namespace

void control::dispatch(const ServerMessage& msg) {
  switch (msg.kind) {
    case ServerMessage::SET_COLOR:
      led::setTally(msg.r, msg.g, msg.b, msg.brightness, led::STEADY);
      TLOG(LOG_LEVEL_INFO, "SET_COLOR rgb(%u,%u,%u) bri=%u\n", msg.r, msg.g, msg.b, msg.brightness);
      break;
    case ServerMessage::SET_WIFI:
      wifi::provision(msg.ssid, msg.pass);
      settings::setTransportMode(TRANSPORT_WIFI);  // provisioning implies "use WiFi when unplugged"
      emitStatus();
      break;
    case ServerMessage::SET_TRANSPORT:
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
        espnow::enterBridge(msg.channel);  // pin the radio to the received channel (runtime-only)
      else
        espnow::exitBridge();
      emitStatus();  // the STATUS trailing bytes confirm the mode took effect
      break;
    case ServerMessage::RELAY:
      espnow::relay(msg);  // strip header → esp_now_send(targetMAC, inner); dropped if no such peer
      break;
    case ServerMessage::UNKNOWN:
      break;
  }
}

void control::emitStatus() {
  uint8_t transport = settings::transportMode();
  uint8_t ws = wifi::state();
  int8_t rssi = wifi::rssi();
  const char* ssid = wifi::ssid();
  uint8_t channel = settings::espnowChannel();  // the device's stored ESP-NOW channel (default 1)
  bool bridge = espnow::bridgeActive();
  uint8_t payload[39];  // 4-byte head + 1-byte len + up to 32 SSID bytes + channel + bridging
  usb::send(payload, encodeStatusPayload(payload, transport, ws, rssi, ssid,
                                         (uint8_t)strlen(ssid), channel, bridge ? 1 : 0));
  g_last.valid = true;
  g_last.transport = transport;
  g_last.wifiState = ws;
  g_last.rssi = rssi;
  strncpy(g_last.ssid, ssid, sizeof(g_last.ssid) - 1);
  g_last.ssid[sizeof(g_last.ssid) - 1] = '\0';
  g_last.channel = channel;
  g_last.bridge = bridge;
}

void control::maybeEmitStatus(unsigned long now) {
  if (now - g_lastEmit < kEmitIntervalMs) return;
  g_lastEmit = now;
  if (!usb::hostPresent()) return;  // no host listening — don't stream into the void
  uint8_t transport = settings::transportMode();
  uint8_t ws = wifi::state();
  int8_t rssi = wifi::rssi();
  const char* ssid = wifi::ssid();
  uint8_t channel = settings::espnowChannel();
  bool bridge = espnow::bridgeActive();
  if (g_last.valid && ws == g_last.wifiState && transport == g_last.transport &&
      abs((int)rssi - (int)g_last.rssi) < kRssiDeltaDbm && strcmp(g_last.ssid, ssid) == 0 &&
      channel == g_last.channel && bridge == g_last.bridge)
    return;
  emitStatus();
}

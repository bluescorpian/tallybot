#include "settings.h"

#include <Preferences.h>

#include "protocol.h"  // TRANSPORT_WIFI, ESPNOW_CHANNEL

namespace {
Preferences g_prefs;
constexpr const char* kTransportKey = "txmode";
constexpr const char* kEspnowChannelKey = "espch";
}  // namespace

void settings::begin() { g_prefs.begin("tally", false); }

uint8_t settings::transportMode() { return g_prefs.getUChar(kTransportKey, TRANSPORT_WIFI); }

void settings::setTransportMode(uint8_t mode) {
  if (g_prefs.getUChar(kTransportKey, 0xFF) != mode) g_prefs.putUChar(kTransportKey, mode);
}

uint8_t settings::espnowChannel() { return g_prefs.getUChar(kEspnowChannelKey, ESPNOW_CHANNEL); }

void settings::setEspnowChannel(uint8_t ch) {
  if (g_prefs.getUChar(kEspnowChannelKey, 0xFF) != ch) g_prefs.putUChar(kEspnowChannelKey, ch);
}

#include "settings.h"

#include <Preferences.h>

#include "protocol.h"  // TRANSPORT_WIFI

namespace {
Preferences g_prefs;
constexpr const char* kTransportKey = "txmode";
}  // namespace

void settings::begin() { g_prefs.begin("tally", false); }

uint8_t settings::transportMode() { return g_prefs.getUChar(kTransportKey, TRANSPORT_WIFI); }

void settings::setTransportMode(uint8_t mode) {
  if (g_prefs.getUChar(kTransportKey, 0xFF) != mode) g_prefs.putUChar(kTransportKey, mode);
}

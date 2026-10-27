#include "settings.h"

#include <Preferences.h>

#include "log.h"
#include "protocol.h"  // TRANSPORT_WIFI, ESPNOW_CHANNEL

namespace {
Preferences g_prefs;
constexpr const char* kTransportKey = "txmode";
constexpr const char* kEspnowChannelKey = "espch";
}  // namespace

// A failure here is otherwise silent: the getters return their defaults (WiFi, the default
// channel), so a light would quietly run the wrong transport. Logged at ERROR, which reaches the
// operator as the light's fault while it's cabled.
void settings::begin() {
  if (!g_prefs.begin("tally", false)) TLOG(LOG_LEVEL_ERROR, "NVS didn't open: running on defaults, settings won't save\n");
}

namespace {
void put(const char* key, uint8_t value) {
  if (g_prefs.putUChar(key, value) == 0) TLOG(LOG_LEVEL_ERROR, "NVS write of %s failed: the setting won't survive a restart\n", key);
}
}  // namespace

uint8_t settings::transportMode() { return g_prefs.getUChar(kTransportKey, TRANSPORT_WIFI); }

void settings::setTransportMode(uint8_t mode) {
  if (g_prefs.getUChar(kTransportKey, 0xFF) != mode) put(kTransportKey, mode);
}

uint8_t settings::espnowChannel() { return g_prefs.getUChar(kEspnowChannelKey, ESPNOW_CHANNEL); }

void settings::setEspnowChannel(uint8_t ch) {
  if (g_prefs.getUChar(kEspnowChannelKey, 0xFF) != ch) put(kEspnowChannelKey, ch);
}

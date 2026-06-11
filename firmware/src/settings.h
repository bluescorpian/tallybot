#pragma once

#include <stdint.h>

// Persistent device settings (NVS "tally" namespace). The transport mode — what the device does
// when unplugged: TRANSPORT_WIFI joins the saved AP, TRANSPORT_NOTX stays wired-only, TRANSPORT_ESPNOW
// links to a bridge. Stored as an int (open enum) so v1.3 ESP-NOW can add a value. Plus the ESP-NOW
// channel a light uses (host-chosen on the wire, defaults to ESPNOW_CHANNEL).
namespace settings {

void begin();
uint8_t transportMode();
void setTransportMode(uint8_t mode);  // persisted, write-on-change

uint8_t espnowChannel();              // the light's ESP-NOW channel (default ESPNOW_CHANNEL)
void setEspnowChannel(uint8_t ch);    // persisted, write-on-change

}  // namespace settings

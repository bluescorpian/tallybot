#pragma once

#include <stdint.h>

// Persistent device settings (NVS "tally" namespace). Currently just the transport mode —
// what the device does when unplugged: TRANSPORT_WIFI joins the saved AP, TRANSPORT_NOTX
// stays wired-only. Stored as an int (open enum) so v1.3 ESP-NOW can add a value.
namespace settings {

void begin();
uint8_t transportMode();
void setTransportMode(uint8_t mode);  // persisted, write-on-change

}  // namespace settings

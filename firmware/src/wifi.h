#pragma once

#include <stdint.h>

// WiFi connection lifecycle for a WiFi-transport device: captive-portal provisioning,
// full-power association, reprovision, and the host-visible join state surfaced in STATUS.
// The radio always runs at full TX power (never capped). A failed join is diagnosed on the
// SoftAP portal landing page.
namespace wifi {

void begin(const char* apSsid);  // configure WiFiManager + disconnect events; build the portal panel
void enableRadio();              // STA mode + channel widening + cache the stored SSID (a WiFi device)
void disableRadio();             // radio off (a No-TX device)

bool connected();
void connectBlocking();  // full-power autoConnect → captive-portal fallback (blocks)
void openPortal();       // force the captive portal now, restoring the saved network if cancelled (blocks)
void beginAssociation(); // non-blocking warm join from stored creds (no portal); kept warm for USB-first boot
void provision(const char* ssid, const char* pass);  // SET_WIFI: save-only, no validating join

// Sustained-loss handling: shows the amber "lost WiFi" indicator and, after a timeout, returns
// true to ask the caller to reprovision. noteUp() clears the loss timer once reconnected.
bool serviceDown(unsigned long now);
void noteUp();

void cancelJoin();    // drop the host-visible join lifecycle (e.g. switching to No-TX)

// Host-visible status, for STATUS frames.
uint8_t state();      // WIFI_STATE_*
const char* ssid();   // safe stored/associated SSID (never uninitialised garbage)
int8_t rssi();

}  // namespace wifi

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

// ESP-NOW transport (v1.3) — the same firmware in two roles, behind one small API:
//
//   • Light  — a tally device provisioned TRANSPORT_ESPNOW. With no AP to join it broadcasts
//              TALLY_FIND, links to whichever bridge answers TALLY_HERE, sends HELLO then
//              HEARTBEATs, and renders the bridge's SET_COLORs. It is the ESP-NOW mirror of the
//              WiFi `tally` client, one layer down.
//   • Bridge — entered at runtime over USB (SET_BRIDGE 1). It registers any light that discovers
//              it as a peer, wraps every other peer frame in a RELAY-up envelope to the USB pipe, and unwraps
//              RELAY frames from the host down to a peer. A dumb byte-forwarder: it never decodes
//              the inner payload. A bridge is a normal USB tally device that *additionally* relays.
//
// ESP-NOW receive callbacks run outside the main loop, so inbound frames are marshalled into a
// ring buffer and drained from loopLight()/loopBridge() — FastLED and the USB send path are never
// touched from callback context. Decoded light-bound commands are handed to the handler passed to
// init() (the same control::dispatch the other transports feed).
namespace espnow {

using MessageHandler = void (*)(const ServerMessage&);

void init(const uint8_t mac[6], MessageHandler onMessage);

// ── Light role (transport mode ESPNOW, unplugged) ──────────────────────────────
void startLight();              // bring the radio up on the persisted channel + begin discovery (cyan searching)
void stopLight();               // tear the radio down (USB won the cable, or leaving ESP-NOW)
void loopLight(unsigned long now);

// ── Bridge role (runtime, any NVS transport underneath) ────────────────────────
void enterBridge(uint8_t channel);  // SET_BRIDGE 1: radio up on `channel`, suppress association, start relaying
void exitBridge();              // SET_BRIDGE 0 / USB session end: deinit + restore radio per NVS mode
bool bridgeActive();
void loopBridge();              // no clock — the bridge is stateless in time (liveness is the sidecar's)
void relay(const ServerMessage& msg);  // RELAY from USB → esp_now_send(targetMAC, inner)

}  // namespace espnow

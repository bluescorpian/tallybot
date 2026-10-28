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
void startLight();              // bring the radio up on the persisted channel + begin discovery (cyan searching);
                                // unlinked past CHANNEL_HUNT_AFTER_MS, it hunts channels 1–13 for a bridge
void stopLight();               // tear the radio down (USB won the cable, or leaving ESP-NOW)
void loopLight(unsigned long now);

// ── Bridge role (runtime, any NVS transport underneath) ────────────────────────
// SET_BRIDGE 1: radio up on `channel` at `txPower` (quarter-dBm), suppress association, start
// relaying and beaconing. While already bridging, re-powers in place at once, and moves to a new
// channel in place after announcing it on the old one for about half a second (loopBridge).
void enterBridge(uint8_t channel, uint8_t txPower);
void exitBridge();              // SET_BRIDGE 0 / USB session end: deinit + restore radio per NVS mode
bool bridgeActive();
// A channel move announces MOVE_ANNOUNCEMENTS times, MOVE_ANNOUNCE_MS apart, and retunes one
// interval after the last: MOVE_MS from the SET_BRIDGE (a new target mid-move starts it again).
constexpr uint8_t MOVE_ANNOUNCEMENTS = 5;
constexpr unsigned long MOVE_ANNOUNCE_MS = 100;
constexpr unsigned long MOVE_MS = MOVE_ANNOUNCEMENTS * MOVE_ANNOUNCE_MS;
// False while a bridge's channel move is pending, or less than `settleMs` after it retuned: lights
// that followed the announcement are on the new channel without a frame from the bridge since. True
// when not a bridge. A scan waits for it (scan.cpp), so its time off-channel isn't added to theirs.
bool bridgeSettled(unsigned long settleMs);
// After a WiFi scan: back on the bridge channel. True when re-pinned (or not a bridge). A refusal
// (the driver may still be scanning) is retried by the caller; lastTry leaves bridge mode instead.
bool repinBridge(bool lastTry);
void loopBridge(unsigned long now);  // drain, relay up, beacon, channel move; `now` paces only the 1 s diagnostics line
void relay(const ServerMessage& msg);  // RELAY from USB → esp_now_send(targetMAC, inner)

}  // namespace espnow

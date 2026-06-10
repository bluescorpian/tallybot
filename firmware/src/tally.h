#pragma once

#include <stdint.h>

#include "protocol.h"

// The WiFi tally client: UDP discovery of the sidecar, a TCP connection, HELLO + periodic
// HEARTBEAT, and the inbound SET_COLOR/IDENTIFY stream. Assumes WiFi is up (the caller gates on
// that). Decoded server commands are handed to the handler passed to init().
namespace tally {

using MessageHandler = void (*)(const ServerMessage&);

void init(const uint8_t mac[6], MessageHandler onMessage);
void start();  // (re)bind the discovery socket and begin hunting for the server
void stop();   // drop TCP + close the discovery socket
void loop(unsigned long now);

}  // namespace tally

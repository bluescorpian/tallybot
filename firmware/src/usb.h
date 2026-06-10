#pragma once

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

// USB-CDC control channel: COBS-framed payloads (PacketSerial) over the native USB serial port.
// Pure transport + session bookkeeping — it knows nothing about WiFi or tally state. Decoded
// host commands are handed to the handler passed to begin().
namespace usb {

using MessageHandler = void (*)(const ServerMessage&);

void begin(const uint8_t mac[6], MessageHandler onMessage);

// Pump RX into the COBS parser and re-announce HELLO until a host replies. Returns true on the
// single tick a USB tally session goes idle (the host fell silent) — the cue to revert to WiFi.
bool loop(unsigned long now);

void send(const uint8_t* payload, size_t len);
bool hostPresent();   // a host frame has arrived this session
bool tallyActive();   // the app is currently driving tally over USB
void resetSession();  // forget host/tally so HELLO re-announces and STATUS re-syncs

}  // namespace usb

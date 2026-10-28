#pragma once

#include <stdint.h>

#include "protocol.h"

// Routes a decoded server/host command to the right module — the one place that knows how a
// command maps to led/wifi/settings/usb. Shared by both transports: SET_COLOR arrives over TCP
// and USB; SET_WIFI/SET_TRANSPORT/GET_STATUS over USB only. SCAN_WIFI is acted on only from USB
// (dispatchUsb), since the decoder is shared and would also accept it over TCP or in a RELAY.
// Also owns STATUS emission.
namespace control {

void dispatch(const ServerMessage& msg);
void dispatchUsb(const ServerMessage& msg);  // a USB host's command: dispatch() plus the USB-only SCAN_WIFI
void runDeferred();                          // replay radio commands that arrived mid-scan, once it's done
void emitStatus();                        // build + send a STATUS frame now
void maybeEmitStatus(unsigned long now);  // throttled; sends only on change while a host is cabled

}  // namespace control

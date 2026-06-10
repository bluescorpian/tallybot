#pragma once

#include <stdint.h>

#include "protocol.h"

// Routes a decoded server/host command to the right module — the one place that knows how a
// command maps to led/wifi/settings/usb. Shared by both transports: SET_COLOR/IDENTIFY arrive
// over TCP and USB; SET_WIFI/SET_TRANSPORT/GET_STATUS over USB only. Also owns STATUS emission.
namespace control {

void dispatch(const ServerMessage& msg);
void emitStatus();                        // build + send a STATUS frame now
void maybeEmitStatus(unsigned long now);  // throttled; sends only on change while a host is cabled

}  // namespace control

#pragma once

#include <Arduino.h>

#include "protocol.h"  // LOG_LEVEL_*

// One logging seam. Dev builds print plain text to Serial so `pio device monitor` and the
// exception decoder stay usable; release builds frame each line as a COBS LOG packet the host
// demuxes (raw text would corrupt the host's COBS stream). printf-style; `level` is LOG_LEVEL_*.
#ifdef TALLYBOT_USB_TEXT_LOG
#define TLOG(level, ...) ::Serial.printf(__VA_ARGS__)
#else
namespace usb {
void logf(uint8_t level, const char* fmt, ...);  // defined in usb.cpp
}
#define TLOG(level, ...) ::usb::logf((level), __VA_ARGS__)
#endif

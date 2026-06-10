#pragma once

#include "led.h"
#include "protocol.h"  // COLOR_DISCONNECTED, COLOR_SETUP, LOCAL_BRIGHTNESS

// Device-local bring-up indicators — the colours/motions the firmware drives itself (the
// server drives the tally colours via SET_COLOR). One named call per LED.md device state, so
// callers read as intent. All are "local": suppressed while a USB tally session owns the LED.
namespace ind {

inline void joiningWifi() { led::setLocal(255, 120, 0, LOCAL_BRIGHTNESS, led::SLOW_PULSE); }   // amber pulse
inline void wifiLost() { led::setLocal(255, 120, 0, LOCAL_BRIGHTNESS, led::FAST_BLINK); }      // amber blink
inline void searching() { led::setLocal(0, 255, 255, LOCAL_BRIGHTNESS, led::SLOW_PULSE); }     // cyan pulse
inline void unassigned() { led::setLocal(255, 255, 255, LOCAL_BRIGHTNESS, led::BREATHE); }     // white breathe
inline void lostServer() { led::setLocal(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS, led::STEADY); } // steady blue
inline void setup() { led::setLocal(COLOR_SETUP, LOCAL_BRIGHTNESS, led::STEADY); }             // magenta

}  // namespace ind

#pragma once

#include <stdint.h>

// The onboard WS2812 on GPIO8. Owns all rendering: a resting colour + motion the loop
// re-renders each tick.
//
//   setTally  — server/app colours (SET_COLOR). Brightness is perceptual and gamma-corrected
//               here. Always applied.
//   setLocal  — device-local bring-up indicators. Suppressed while a USB tally session owns
//               the LED (suppressLocal) so the app's colours win.
namespace led {

enum Motion { STEADY, SLOW_PULSE, FAST_BLINK, BREATHE };

void begin();
void bootSelfTest();  // R→G→B→W power-on check (~1s, blocking)
void setTally(uint8_t r, uint8_t g, uint8_t b, uint8_t perceptualBrightness, Motion m = STEADY);
void setLocal(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness, Motion m = STEADY);
void suppressLocal(bool on);  // true while USB tally drives the LED
void render(unsigned long now);

}  // namespace led

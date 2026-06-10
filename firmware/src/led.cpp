#include "led.h"

#include <FastLED.h>

#include "protocol.h"  // LOCAL_BRIGHTNESS

namespace {
constexpr uint8_t kPin = 8;
constexpr uint8_t kCount = 1;

constexpr unsigned long kPulsePeriodMs = 1500;
constexpr unsigned long kBreathePeriodMs = 10000;
constexpr unsigned long kFastBlinkMs = 200;
constexpr unsigned long kBootStepMs = 250;
constexpr float kGamma = 2.5f;

CRGB g_leds[kCount];

// What's currently on the LED — a dirty-check, so show() (which briefly disables interrupts)
// only fires when something actually changes.
bool g_shownValid = false;
uint8_t g_shownR, g_shownG, g_shownB, g_shownBri;

// The resting colour + motion the loop re-renders each tick.
uint8_t g_r = 0, g_g = 0, g_b = 0, g_bri = LOCAL_BRIGHTNESS;
led::Motion g_motion = led::STEADY;
bool g_suppressLocal = false;

void show(uint8_t r, uint8_t g, uint8_t b, uint8_t bri) {
  if (g_shownValid && r == g_shownR && g == g_shownG && b == g_shownB && bri == g_shownBri) return;
  g_leds[0] = CRGB(r, g, b);
  FastLED.setBrightness(bri);
  FastLED.show();
  g_shownValid = true;
  g_shownR = r;
  g_shownG = g;
  g_shownB = b;
  g_shownBri = bri;
}

// Map a 0–255 wave onto [loPct%..100%] of base.
uint8_t scaleRange(uint8_t wave, uint8_t base, uint8_t loPct) {
  uint8_t lo = (uint16_t)base * loPct / 100;
  return lo + (uint16_t)(base - lo) * wave / 255;
}

// sin8() gives a cheap smooth swell for the pulse/breathe motions; the blink is a square wave.
uint8_t motionBrightness(led::Motion m, uint8_t base, unsigned long now) {
  switch (m) {
    case led::SLOW_PULSE:
      return scaleRange(sin8((uint8_t)((now % kPulsePeriodMs) * 256 / kPulsePeriodMs)), base, 30);
    case led::BREATHE:
      return scaleRange(sin8((uint8_t)((now % kBreathePeriodMs) * 256UL / kBreathePeriodMs)), base, 10);
    case led::FAST_BLINK:
      return ((now / kFastBlinkMs) & 1) ? 0 : base;
    default:
      return base;
  }
}

void setResting(uint8_t r, uint8_t g, uint8_t b, uint8_t bri, led::Motion m) {
  g_r = r;
  g_g = g;
  g_b = b;
  g_bri = bri;
  g_motion = m;
  show(r, g, b, motionBrightness(m, bri, millis()));
}
}  // namespace

void led::begin() { FastLED.addLeds<WS2812, kPin, GRB>(g_leds, kCount); }

void led::bootSelfTest() {
  show(255, 0, 0, LOCAL_BRIGHTNESS);
  delay(kBootStepMs);
  show(0, 255, 0, LOCAL_BRIGHTNESS);
  delay(kBootStepMs);
  show(0, 0, 255, LOCAL_BRIGHTNESS);
  delay(kBootStepMs);
  show(255, 255, 255, LOCAL_BRIGHTNESS);
  delay(kBootStepMs);
}

void led::setTally(uint8_t r, uint8_t g, uint8_t b, uint8_t perceptual, Motion m) {
  setResting(r, g, b, applyGamma_video(perceptual, kGamma), m);
}

void led::setLocal(uint8_t r, uint8_t g, uint8_t b, uint8_t bri, Motion m) {
  if (!g_suppressLocal) setResting(r, g, b, bri, m);
}

void led::suppressLocal(bool on) { g_suppressLocal = on; }

void led::render(unsigned long now) {
  show(g_r, g_g, g_b, motionBrightness(g_motion, g_bri, now));
}

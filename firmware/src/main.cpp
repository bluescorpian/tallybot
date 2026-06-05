// TallyBot firmware — hello-world for the ESP32-C3 SuperMini.
//
// Proves the toolchain and the two foundations every later feature depends on:
//   1. driving the onboard addressable LED, and
//   2. reading the device's MAC address (its identity on the network).
//
// It stays deliberately offline — no WiFi connect, no discovery, no protocol — so a
// failure here points at hardware/toolchain, not networking. The real tally client
// (provisioning, discovery, TCP, SET_COLOR/IDENTIFY) lands in Phase 3; see README.md.
//
// Board gotchas this sketch respects (CLAUDE.md / ARCHITECTURE.md):
//   * GPIO8 is an addressable WS2812, not a digital pin — driven via FastLED only.
//   * Never sleep: the loop stays busy so a USB power bank's auto-off won't cut power.
//   * Serial reaches USB only with the ARDUINO_USB_CDC_ON_BOOT flag (set in platformio.ini).

#include <Arduino.h>
#include <FastLED.h>
#include <WiFi.h>  // for WiFi.macAddress() — no connection is made

// The single onboard RGB LED. WS2812 on GPIO8, GRB byte order.
#define LED_PIN 8
#define NUM_LEDS 1
#define LED_BRIGHTNESS 64  // modest — the onboard LED is bright and close to the eye

static CRGB leds[NUM_LEDS];

// One step of the self-test: a colour and how long to hold it (ms).
struct TestStep {
  const char *name;
  CRGB color;
  uint16_t holdMs;
};

// The palette the product actually uses (see ARCHITECTURE.md "Standard LED colours"),
// so this doubles as a sanity check that the colour order is correct.
static const TestStep STEPS[] = {
    {"live    (red)", CRGB(255, 0, 0), 1000},
    {"preview (green)", CRGB(0, 255, 0), 1000},
    {"blue", CRGB(0, 0, 255), 1000},
    {"idle    (dim white)", CRGB(30, 30, 30), 1000},
    {"off", CRGB::Black, 1000},
};
static const size_t NUM_STEPS = sizeof(STEPS) / sizeof(STEPS[0]);

// Read and format the MAC as AA:BB:CC:DD:EE:FF. Works without WiFi.begin().
static String macAddress() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[18];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1],
           mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

void setup() {
  Serial.begin(115200);

  // Give the USB-CDC link a moment to enumerate so the banner isn't lost. Bounded —
  // not `while (!Serial)` — because the board may run headless off a power bank with
  // no host attached, and must never block there.
  unsigned long start = millis();
  while (!Serial && millis() - start < 2000) {
    delay(10);
  }

  Serial.println();
  Serial.println(F("=== TallyBot firmware — hello world ==="));
  Serial.printf("chip: %s rev %d, %d core(s)\n", ESP.getChipModel(),
                ESP.getChipRevision(), ESP.getChipCores());
  Serial.printf("MAC:  %s\n", macAddress().c_str());

  FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(LED_BRIGHTNESS);

  Serial.println(F("LED self-test running (red, green, blue, dim white, off)..."));
}

void loop() {
  // Re-print the MAC each cycle so a monitor attached after boot still sees it.
  Serial.printf("MAC: %s — LED cycle\n", macAddress().c_str());

  for (size_t i = 0; i < NUM_STEPS; i++) {
    leds[0] = STEPS[i].color;
    FastLED.show();
    Serial.printf("  LED: %s\n", STEPS[i].name);
    delay(STEPS[i].holdMs);
  }
}

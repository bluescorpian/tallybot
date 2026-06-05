// TallyBot firmware — the tally-light client for the ESP32-C3 SuperMini.
//
// On the wire this is a TCP *client* (ARCHITECTURE.md): it provisions WiFi via a
// captive portal, discovers the sidecar over UDP broadcast, opens a TCP connection,
// sends HELLO then HEARTBEATs, and drives the onboard WS2812 LED from the server's
// SET_COLOR / IDENTIFY commands. The binary wire format lives in `protocol.h` (the
// C++ mirror of `app/sidecar/src/protocol.ts`).
//
// It can be developed and tested with no ATEM and no app, against the standalone
// sidecar dev runner (`tools/`, `pnpm sidecar-dev`), which binds TCP 7000 / UDP 7001.
//
// Board gotchas this firmware respects (CLAUDE.md / ARCHITECTURE.md):
//   * GPIO8 is an addressable WS2812, not a digital pin — driven via FastLED only.
//   * Never sleep: the loop stays busy (no deep/light sleep) so a USB power bank's
//     auto-off can't cut power on low current. WiFi stays active throughout.
//   * WiFi TX-power fallback: WiFi.setTxPower(WIFI_POWER_8_5dBm) before connecting,
//     a safe workaround for older C3 boards whose antenna won't otherwise associate.
//   * Serial reaches USB only with the ARDUINO_USB_CDC_ON_BOOT flag (platformio.ini).
//
// LED meaning (see ARCHITECTURE.md "Failure signalling"):
//   * Magenta (local) ...... captive portal up — join the TallyLight-XXXXXX AP.
//   * Steady blue (local) .. no trusted server: connecting / discovering / dropped,
//                            and the gap after connect before the first SET_COLOR.
//   * Server colours ....... live / preview / idle / server-driven flashing fault.
//   * Brief white flash .... IDENTIFY — so the operator can locate this device.

#include <Arduino.h>
#include <FastLED.h>
#include <WiFi.h>
#include <WiFiManager.h>  // tzapu/WiFiManager — SoftAP captive portal + NVS creds
#include <WiFiUdp.h>

#include "protocol.h"

// ── LED ──────────────────────────────────────────────────────────────────────
#define LED_PIN 8
#define NUM_LEDS 1

// ── Tunables (device-local policy, not part of the wire protocol) ────────────
#define TCP_CONNECT_TIMEOUT_MS 3000  // cap the one tolerated blocking call
#define BACKOFF_MS 2000              // wait before re-discovering after a TCP drop
#define WIFI_LOST_PORTAL_MS 60000    // sustained WiFi loss before re-arming the AP
#define IDENTIFY_TOGGLE_MS 150       // IDENTIFY flash half-period
#define IDENTIFY_TOGGLES 6           // total toggles (~0.9s of white/colour blinking)
#define BRIGHTNESS_GAMMA 2.5f        // perceptual brightness byte → LED drive (see below)

// ── Top-level state machine ──────────────────────────────────────────────────
enum State {
  ST_PROVISIONING,  // captive portal / initial autoConnect (blocking, off tally duty)
  ST_DISCOVERING,   // WiFi up; broadcasting TALLY_FIND until the server answers
  ST_CONNECTING,    // opening the TCP connection to the discovered server
  ST_CONNECTED,     // HELLO sent; heartbeating; rendering server colours
  ST_BACKOFF,       // TCP dropped; brief wait before re-discovering
};

static State state = ST_PROVISIONING;

// Identity + networking
static uint8_t mac[6];
static char apSsid[24];  // "TallyLight-XXXXXX"
static WiFiManager wm;
static WiFiUDP udp;
static WiFiClient tcp;
static FrameDecoder decoder;
static IPAddress serverIp;
static uint16_t serverPort = SERVER_PORT;

// Timers (all rollover-safe millis() deltas)
static unsigned long lastDiscoveryBroadcast = 0;
static unsigned long lastHeartbeat = 0;
static unsigned long backoffStart = 0;
static unsigned long wifiLostSince = 0;  // 0 = WiFi believed up

// ── LED rendering ────────────────────────────────────────────────────────────
static CRGB leds[NUM_LEDS];

// The colour to show when not mid-IDENTIFY (set by SET_COLOR, or a device-local
// signal). IDENTIFY flashes over the top of it, then restores it.
static uint8_t restR = 0, restG = 0, restB = 0, restBrightness = LOCAL_BRIGHTNESS;

// Last values actually pushed to the LED — a dirty-check so we only call
// FastLED.show() (which briefly disables interrupts) when something changes.
static bool shownValid = false;
static uint8_t shownR = 0, shownG = 0, shownB = 0, shownBrightness = 0;

static bool identifyActive = false;
static unsigned long identifyStart = 0;

static void applyColor(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness) {
  if (shownValid && r == shownR && g == shownG && b == shownB && brightness == shownBrightness) {
    return;  // already on screen
  }
  leds[0] = CRGB(r, g, b);
  FastLED.setBrightness(brightness);
  FastLED.show();
  shownValid = true;
  shownR = r;
  shownG = g;
  shownB = b;
  shownBrightness = brightness;
}

// Set the resting colour. Shows it immediately unless an IDENTIFY flash is running
// (the flash restores the resting colour when it ends). Safe to call every loop —
// applyColor() de-dupes — and safe from a blocking WiFiManager callback.
static void setResting(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness) {
  restR = r;
  restG = g;
  restB = b;
  restBrightness = brightness;
  if (!identifyActive) applyColor(r, g, b, brightness);
}

static void startIdentify() {
  identifyActive = true;
  identifyStart = millis();
}

// Drive the LED for this tick: the resting colour, or the IDENTIFY flash if active.
static void renderLed(unsigned long now) {
  if (!identifyActive) {
    applyColor(restR, restG, restB, restBrightness);
    return;
  }
  unsigned long elapsed = now - identifyStart;
  unsigned long phase = elapsed / IDENTIFY_TOGGLE_MS;
  if (phase >= IDENTIFY_TOGGLES) {
    identifyActive = false;
    applyColor(restR, restG, restB, restBrightness);
    return;
  }
  if (phase % 2 == 0) {
    applyColor(255, 255, 255, DEFAULT_BRIGHTNESS);  // bright white
  } else {
    applyColor(restR, restG, restB, restBrightness);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Lowercase colon form, matching how the server logs a device's MAC.
static void macToStr(char* out, size_t n) {
  snprintf(out, n, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

// Parse a "TALLY_HERE:<port>" datagram. Returns true and fills *port on success.
static bool parseDiscoveryResponse(const char* msg, uint16_t* port) {
  const size_t prefixLen = strlen(DISCOVERY_RESPONSE_PREFIX);
  if (strncmp(msg, DISCOVERY_RESPONSE_PREFIX, prefixLen) != 0) return false;
  char* end = nullptr;
  long p = strtol(msg + prefixLen, &end, 10);
  if (end == msg + prefixLen || p < 1 || p > 65535) return false;
  *port = (uint16_t)p;
  return true;
}

// Decode one framed server payload and act on it. Used as the FrameDecoder callback.
static void onPayload(const uint8_t* payload, size_t len) {
  ServerMessage msg;
  if (!decodeServerMessage(payload, len, &msg)) return;  // skip unknown/malformed
  if (msg.kind == ServerMessage::SET_COLOR) {
    // The brightness byte is a *perceptual* value, not a raw drive level — the device
    // owns the linearity correction (ARCHITECTURE.md "Brightness is a perceptual value").
    // The sidecar/UI keep it linear; we gamma-correct here so the UI's even 0–10 levels
    // appear evenly spaced rather than bunched at the dim end. applyGamma_video keeps a
    // non-zero byte from collapsing to off.
    uint8_t drive = applyGamma_video(msg.brightness, BRIGHTNESS_GAMMA);
    setResting(msg.r, msg.g, msg.b, drive);
    Serial.printf("SET_COLOR rgb(%u,%u,%u) brightness=%u (gamma→%u)\n", msg.r, msg.g, msg.b,
                  msg.brightness, drive);
  } else if (msg.kind == ServerMessage::IDENTIFY) {
    startIdentify();
    Serial.println("IDENTIFY");
  }
}

static void enterDiscovering(unsigned long now) {
  state = ST_DISCOVERING;
  lastDiscoveryBroadcast = now - DISCOVERY_INTERVAL_MS;  // broadcast on the next tick
  setResting(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS);
}

// Re-arm the captive portal after a sustained WiFi outage. Blocking — acceptable,
// since with no WiFi the device can't do anything else anyway. AP comes up *only*
// here and on first boot, never on a mere TCP drop.
static void reprovision() {
  Serial.println("WiFi down too long — reopening the config portal");
  state = ST_PROVISIONING;
  setResting(COLOR_SETUP, LOCAL_BRIGHTNESS);  // magenta hint
  wm.startConfigPortal(apSsid);               // blocks until reconfigured + connected
  udp.stop();
  udp.begin(DISCOVERY_PORT);
  wifiLostSince = 0;
  enterDiscovering(millis());
  Serial.printf("WiFi reconnected, IP %s\n", WiFi.localIP().toString().c_str());
}

// WiFi has dropped out from under us. Tear down TCP, fall back to steady blue, and
// let the core auto-reconnect; only after a sustained outage do we re-arm the AP.
static void handleWifiDown(unsigned long now) {
  if (tcp.connected()) tcp.stop();
  if (state == ST_CONNECTED || state == ST_CONNECTING) state = ST_DISCOVERING;
  setResting(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS);
  if (wifiLostSince == 0) {
    wifiLostSince = now;
    Serial.println("WiFi connection lost; waiting for auto-reconnect");
  } else if (now - wifiLostSince >= WIFI_LOST_PORTAL_MS) {
    reprovision();
  }
}

// WiFiManager raised the captive portal. Show the magenta provisioning hint. Runs
// inside the blocking autoConnect/startConfigPortal call, so it shows immediately.
static void onConfigPortal(WiFiManager*) {
  Serial.printf("Config portal up — join WiFi AP \"%s\", then open 192.168.4.1\n", apSsid);
  setResting(COLOR_SETUP, LOCAL_BRIGHTNESS);
}

// ── Arduino entry points ─────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  // Bounded wait for USB-CDC to enumerate (not `while (!Serial)`): the board may run
  // headless off a power bank with no host attached, and must never block there.
  unsigned long start = millis();
  while (!Serial && millis() - start < 2000) delay(10);

  WiFi.macAddress(mac);
  // AP SSID from the last 3 MAC octets, uppercase — "TallyLight-XXXXXX".
  snprintf(apSsid, sizeof(apSsid), "TallyLight-%02X%02X%02X", mac[3], mac[4], mac[5]);

  char macStr[18];
  macToStr(macStr, sizeof(macStr));
  Serial.println();
  Serial.println(F("=== TallyBot tally light ==="));
  Serial.printf("chip: %s rev %d\n", ESP.getChipModel(), ESP.getChipRevision());
  Serial.printf("MAC:  %s   AP: %s\n", macStr, apSsid);

  FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, NUM_LEDS);
  // Show steady blue while we attempt to connect (magenta only once the portal opens).
  setResting(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS);

  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_8_5dBm);  // safe fallback for older C3 antennas

  // Provision: connect with saved creds, or raise the SoftAP captive portal. Blocking
  // is fine here — the device isn't on tally duty until it has a network. Creds persist
  // to NVS, so this only opens the portal on first boot or when saved creds fail.
  wm.setAPCallback(onConfigPortal);
  state = ST_PROVISIONING;
  wm.autoConnect(apSsid);
  Serial.printf("WiFi connected, IP %s\n", WiFi.localIP().toString().c_str());

  udp.begin(DISCOVERY_PORT);  // bind 7001 to catch both the unicast reply and broadcasts
  enterDiscovering(millis());
}

void loop() {
  unsigned long now = millis();

  // WiFi is the authoritative "network up" signal, distinct from a TCP drop.
  if (WiFi.status() != WL_CONNECTED) {
    handleWifiDown(now);
    renderLed(now);
    delay(1);
    return;
  }
  if (wifiLostSince != 0) {  // WiFi just came back without needing the portal
    Serial.printf("WiFi reconnected, IP %s\n", WiFi.localIP().toString().c_str());
    wifiLostSince = 0;
    udp.stop();
    udp.begin(DISCOVERY_PORT);  // the socket may not survive an interface bounce
    enterDiscovering(now);
  }

  switch (state) {
    case ST_PROVISIONING:
      // Reached only transiently; setup()/reprovision() leave us in ST_DISCOVERING.
      enterDiscovering(now);
      break;

    case ST_DISCOVERING: {
      if (now - lastDiscoveryBroadcast >= DISCOVERY_INTERVAL_MS) {
        udp.beginPacket(IPAddress(255, 255, 255, 255), DISCOVERY_PORT);
        udp.write((const uint8_t*)DISCOVERY_REQUEST, strlen(DISCOVERY_REQUEST));
        udp.endPacket();
        lastDiscoveryBroadcast = now;
      }
      int sz = udp.parsePacket();
      if (sz > 0) {
        char buf[32];
        int n = udp.read((uint8_t*)buf, sizeof(buf) - 1);
        if (n < 0) n = 0;
        buf[n] = '\0';
        uint16_t port;
        if (parseDiscoveryResponse(buf, &port)) {
          serverIp = udp.remoteIP();  // valid right after parsePacket(): the server's IP
          serverPort = port;
          Serial.printf("Found server at %s:%u\n", serverIp.toString().c_str(), port);
          state = ST_CONNECTING;
        }
      }
      break;
    }

    case ST_CONNECTING: {
      decoder.reset();
      if (tcp.connect(serverIp, serverPort, TCP_CONNECT_TIMEOUT_MS)) {
        uint8_t hello[9];
        size_t n = encodeHello(hello, mac);
        tcp.write(hello, n);
        lastHeartbeat = now;
        state = ST_CONNECTED;
        Serial.printf("Connected to %s:%u; HELLO sent\n", serverIp.toString().c_str(), serverPort);
        // LED stays blue until the first SET_COLOR — correct for connected-but-unassigned.
      } else {
        Serial.println("TCP connect failed; backing off");
        backoffStart = now;
        state = ST_BACKOFF;
      }
      break;
    }

    case ST_CONNECTED: {
      if (!tcp.connected() && tcp.available() == 0) {
        Serial.println("Server connection lost");
        tcp.stop();
        setResting(COLOR_DISCONNECTED, LOCAL_BRIGHTNESS);
        backoffStart = now;
        state = ST_BACKOFF;
        break;
      }
      uint8_t chunk[64];
      while (tcp.available() > 0) {
        int n = tcp.read(chunk, sizeof(chunk));
        if (n <= 0) break;
        decoder.push(chunk, (size_t)n, onPayload);
      }
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        uint8_t hb[2];
        encodeHeartbeat(hb);
        tcp.write(hb, 2);
        lastHeartbeat = now;
      }
      break;
    }

    case ST_BACKOFF:
      if (now - backoffStart >= BACKOFF_MS) enterDiscovering(now);
      break;
  }

  renderLed(now);
  delay(1);  // yield to the WiFi stack / feed the watchdog — not a sleep
}

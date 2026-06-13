#include "usb.h"

#include <Arduino.h>
#include <PacketSerial.h>
#include <stdarg.h>
#include <string.h>

#include "led.h"
#include "log.h"

namespace {
constexpr unsigned long kHelloIntervalMs = 1000;  // re-announce HELLO until the host replies
constexpr unsigned long kTallyIdleMs = 5000;       // USB silence after which we release tally
constexpr unsigned long kSessionIdleMs = 5000;     // any-frame silence after which the host is gone

PacketSerial g_packet;
usb::MessageHandler g_handler = nullptr;
uint8_t g_mac[6];

bool g_hostSeen = false;
bool g_tallyActive = false;
unsigned long g_lastTally = 0;
unsigned long g_lastFrame = 0;  // any host frame — drives the session-lost edge (bridge teardown)
unsigned long g_lastHello = 0;

void onPacket(const uint8_t* payload, size_t len) {
  ServerMessage msg;
  if (!decodeServerMessage(payload, len, &msg)) return;
  g_hostSeen = true;  // any host frame stops the HELLO re-announce
  g_lastFrame = millis();
  if (msg.kind == ServerMessage::SET_COLOR) {
    g_tallyActive = true;  // the app drives tally now; local indicators step aside
    g_lastTally = millis();
    led::suppressLocal(true);
  }
  if (g_handler) g_handler(msg);
}
}  // namespace

void usb::begin(const uint8_t mac[6], MessageHandler onMessage) {
  memcpy(g_mac, mac, 6);
  g_handler = onMessage;
  Serial.setTxTimeoutMs(0);  // MANDATORY: else CDC TX blocks when the host isn't reading
  g_packet.setStream(&Serial);
  g_packet.setPacketHandler(&onPacket);
}

void usb::send(const uint8_t* payload, size_t len) { g_packet.send(payload, len); }

void usb::sendHello() {
  uint8_t payload[8];
  send(payload, encodeHelloPayload(payload, g_mac));
}

bool usb::loop(unsigned long now) {
  g_packet.update();

  if (!g_hostSeen && now - g_lastHello >= kHelloIntervalMs) {
    g_lastHello = now;
    sendHello();
  }

  // Freshness checks compare against millis() NOW, never the caller's loop-top `now`:
  // g_lastTally/g_lastFrame are stamped *inside* g_packet.update() above, so a frame landing
  // mid-tick is stamped NEWER than `now` — and the unsigned subtraction would underflow to
  // ~49 days, firing the idle edge instantly. (Seen in the field as a one-frame cyan flash on
  // tally changes, and as bridge mode tearing down the moment relay traffic started.)
  if (g_tallyActive && millis() - g_lastTally >= kTallyIdleMs) {
    g_tallyActive = false;
    led::suppressLocal(false);
    TLOG(LOG_LEVEL_INFO, "USB tally idle; releasing local indicators\n");
    return true;
  }
  return false;
}

bool usb::hostPresent() { return g_hostSeen; }
bool usb::tallyActive() { return g_tallyActive; }

// Bridge teardown cue: the host has been silent past the session timeout. Unlike the tally-idle
// edge above (SET_COLOR only), this watches *any* host frame, so a bridge that only relays (no
// direct tally) still detects the host vanishing. Caller resets the session, which clears
// g_hostSeen so this can't re-fire until a new host appears. Reads millis() itself rather than
// taking the caller's loop-top `now` — g_lastFrame is stamped during this tick's RX pump, so a
// stale `now` underflows the subtraction and reads a just-seen host as 49 days silent.
bool usb::sessionLost() {
  return g_hostSeen && millis() - g_lastFrame >= kSessionIdleMs;
}

void usb::resetSession() {
  g_hostSeen = false;
  g_tallyActive = false;
  led::suppressLocal(false);
  g_lastHello = 0;  // re-announce HELLO on the next tick
}

#ifndef TALLYBOT_USB_TEXT_LOG
// Release builds frame each log line as a COBS LOG packet. Best-effort (CDC TX is non-blocking).
void usb::logf(uint8_t level, const char* fmt, ...) {
  char msg[200];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);
  if (n < 0) return;
  size_t mlen = ((size_t)n < sizeof(msg)) ? (size_t)n : sizeof(msg) - 1;
  uint8_t payload[2 + sizeof(msg)];
  send(payload, encodeLogPayload(payload, sizeof(payload), level, msg, mlen));
}
#endif

#include "tally.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <string.h>

#include "indicators.h"
#include "log.h"
#include "usb.h"

namespace {
constexpr unsigned long kConnectTimeoutMs = 3000;
constexpr unsigned long kBackoffMs = 2000;

enum State { DISCOVERING, CONNECTING, CONNECTED, BACKOFF };
State g_state = DISCOVERING;

WiFiUDP g_udp;
WiFiClient g_tcp;
FrameDecoder g_decoder;
IPAddress g_serverIp;
uint16_t g_serverPort = SERVER_PORT;

const uint8_t* g_mac = nullptr;
tally::MessageHandler g_handler = nullptr;
bool g_everHadServer = false;  // splits "first hunt" (cyan) from "lost the server" (blue)

unsigned long g_lastBroadcast = 0;
unsigned long g_lastHeartbeat = 0;
unsigned long g_backoffStart = 0;
unsigned long g_lastServerFrame = 0;  // the last decodable frame from the server (host-silence rule)

void onPayload(const uint8_t* payload, size_t len) {
  ServerMessage msg;
  if (!decodeServerMessage(payload, len, &msg)) return;
  g_lastServerFrame = millis();
  if (g_handler) g_handler(msg);
}

bool parseHere(const char* msg, uint16_t* port) {
  size_t n = strlen(DISCOVERY_RESPONSE_PREFIX);
  if (strncmp(msg, DISCOVERY_RESPONSE_PREFIX, n) != 0) return false;
  char* end = nullptr;
  long p = strtol(msg + n, &end, 10);
  if (end == msg + n || p < 1 || p > 65535) return false;
  *port = (uint16_t)p;
  return true;
}
}  // namespace

void tally::init(const uint8_t mac[6], MessageHandler onMessage) {
  g_mac = mac;
  g_handler = onMessage;
}

void tally::start() {
  if (g_tcp.connected()) g_tcp.stop();
  g_udp.stop();
  g_udp.begin(DISCOVERY_PORT);  // rebind: the socket may not survive an interface bounce
  g_state = DISCOVERING;
  g_lastBroadcast = millis() - DISCOVERY_INTERVAL_MS;  // broadcast on the next tick
  if (g_everHadServer)
    ind::lostServer();  // we LOST the server (check the PC)
  else
    ind::searching();  // first hunt — calm cyan pulse
}

void tally::stop() {
  if (g_tcp.connected()) g_tcp.stop();
  g_udp.stop();
}

void tally::loop(unsigned long now) {
  switch (g_state) {
    case DISCOVERING: {
      if (now - g_lastBroadcast >= DISCOVERY_INTERVAL_MS) {
        g_udp.beginPacket(IPAddress(255, 255, 255, 255), DISCOVERY_PORT);
        g_udp.write((const uint8_t*)DISCOVERY_REQUEST, strlen(DISCOVERY_REQUEST));
        g_udp.endPacket();
        g_lastBroadcast = now;
      }
      if (g_udp.parsePacket() > 0) {
        char buf[32];
        int n = g_udp.read((uint8_t*)buf, sizeof(buf) - 1);
        if (n < 0) n = 0;
        buf[n] = '\0';
        uint16_t port;
        if (parseHere(buf, &port)) {
          g_serverIp = g_udp.remoteIP();
          g_serverPort = port;
          TLOG(LOG_LEVEL_INFO, "Found server %s:%u\n", g_serverIp.toString().c_str(), port);
          g_state = CONNECTING;
        }
      }
      break;
    }

    case CONNECTING: {
      g_decoder.reset();
      if (g_tcp.connect(g_serverIp, g_serverPort, kConnectTimeoutMs)) {
        uint8_t hello[32];
        g_tcp.write(hello, encodeHello(hello, g_mac));
        g_tcp.write(hello, encodeFirmware(hello, sizeof(hello), FIRMWARE_VERSION));
        g_lastHeartbeat = now;
        g_lastServerFrame = millis();
        g_everHadServer = true;  // from now a "no server" signal means we LOST one
        g_state = CONNECTED;
        ind::unassigned();  // white breathe until the first SET_COLOR
        TLOG(LOG_LEVEL_INFO, "Connected %s:%u; HELLO sent\n", g_serverIp.toString().c_str(),
             g_serverPort);
      } else {
        TLOG(LOG_LEVEL_WARN, "TCP connect failed; backing off\n");
        g_backoffStart = now;
        g_state = BACKOFF;
      }
      break;
    }

    case CONNECTED: {
      if (!g_tcp.connected() && g_tcp.available() == 0) {
        TLOG(LOG_LEVEL_WARN, "Server connection lost\n");
        g_tcp.stop();
        ind::lostServer();
        g_backoffStart = now;
        g_state = BACKOFF;
        break;
      }
      uint8_t chunk[64];
      while (g_tcp.available() > 0) {
        int n = g_tcp.read(chunk, sizeof(chunk));
        if (n <= 0) break;
        g_decoder.push(chunk, (size_t)n, onPayload);
      }
      // A half-open socket (PC asleep, a path dropped, a wedged sidecar) can stay "connected" long
      // after the server stopped talking, so the server's own keyframes are the liveness signal, as
      // on USB and ESP-NOW. Skipped while a USB host drives tally: the server then sends colour
      // over USB only, so TCP silence is expected; once USB goes quiet too, this fires at once.
      // millis(), not `now`: the read above may have stamped g_lastServerFrame after `now`.
      if (!usb::tallyActive() && millis() - g_lastServerFrame >= HOST_SILENCE_TIMEOUT_MS) {
        TLOG(LOG_LEVEL_WARN, "No frame from the server in %lums; reconnecting\n",
             (unsigned long)HOST_SILENCE_TIMEOUT_MS);
        g_tcp.stop();
        ind::lostServer();
        g_backoffStart = now;
        g_state = BACKOFF;
        break;
      }
      if (now - g_lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        uint8_t hb[2];
        encodeHeartbeat(hb);
        g_tcp.write(hb, 2);
        g_lastHeartbeat = now;
      }
      break;
    }

    case BACKOFF:
      if (now - g_backoffStart >= kBackoffMs) start();
      break;
  }
}

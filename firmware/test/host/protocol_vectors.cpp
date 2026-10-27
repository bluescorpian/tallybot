// The protocol mirror guard, firmware side: protocol.h compiled for the host and checked against
// the shared `app/sidecar/src/protocol-vectors.json`. Not built by PlatformIO: run it with
// `node scripts/check-protocol-mirrors.mjs`, which turns the vectors into `vectors.inc` (the
// constants as V_* macros, one check call per vector) and compiles this file with it.
#include <stdio.h>

#include <initializer_list>
#include <vector>

#include "protocol.h"

static int g_failures = 0;

static void fail(const char* what, const char* name) {
  fprintf(stderr, "FAIL %s: %s\n", what, name);
  g_failures++;
}

#define CHECK(cond, name)            \
  do {                               \
    if (!(cond)) fail(#cond, name);  \
  } while (0)

using Bytes = std::vector<uint8_t>;

static bool sameBytes(const uint8_t* got, size_t len, const Bytes& want) {
  return len == want.size() && memcmp(got, want.data(), len) == 0;
}

// A server→device vector: decodeServerMessage must reject it, or accept it as `kind` with fields
// `fields` approves of.
template <typename Fields>
static void checkDecode(const char* name, const Bytes& payload, bool accept, ServerMessage::Kind kind, Fields fields) {
  ServerMessage m;
  memset(&m, 0, sizeof m);
  bool ok = decodeServerMessage(payload.data(), payload.size(), &m);
  if (!accept) {
    CHECK(!ok && m.kind == ServerMessage::UNKNOWN, name);
    return;
  }
  CHECK(ok && m.kind == kind && fields(m), name);
}

// A device→server vector the firmware sends: its encoder must produce exactly these bytes.
template <typename Encode>
static void checkEncode(const char* name, const Bytes& want, Encode encode) {
  uint8_t out[64];
  size_t len = encode(out);
  CHECK(sameBytes(out, len, want), name);
}

// The vectors: V_* constants and runVectors(), one check call per vector.
#include "vectors.inc"

static void checkConstants() {
  CHECK(PROTOCOL_VERSION_CURRENT == V_PROTOCOL_VERSION_CURRENT, "PROTOCOL_VERSION_CURRENT");
  CHECK(PROTOCOL_VERSION_MIN_SUPPORTED == V_PROTOCOL_VERSION_MIN_SUPPORTED, "PROTOCOL_VERSION_MIN_SUPPORTED");
  CHECK(SERVER_PORT == V_SERVER_PORT, "SERVER_PORT");
  CHECK(DISCOVERY_PORT == V_DISCOVERY_PORT, "DISCOVERY_PORT");
  CHECK(strcmp(DISCOVERY_REQUEST, V_DISCOVERY_REQUEST) == 0, "DISCOVERY_REQUEST");
  CHECK(strcmp(DISCOVERY_RESPONSE_PREFIX, V_DISCOVERY_RESPONSE_PREFIX) == 0, "DISCOVERY_RESPONSE_PREFIX");

  CHECK(MSG_HELLO == V_deviceMessageType_HELLO, "MSG_HELLO");
  CHECK(MSG_HEARTBEAT == V_deviceMessageType_HEARTBEAT, "MSG_HEARTBEAT");
  CHECK(MSG_STATUS == V_deviceMessageType_STATUS, "MSG_STATUS");
  CHECK(MSG_LOG == V_deviceMessageType_LOG, "MSG_LOG");
  CHECK(MSG_SCAN_RESULT == V_deviceMessageType_SCAN_RESULT, "MSG_SCAN_RESULT");
  CHECK(MSG_RELAY_UP == V_deviceMessageType_RELAY, "MSG_RELAY_UP");
  CHECK(MSG_FIRMWARE == V_deviceMessageType_FIRMWARE, "MSG_FIRMWARE");

  CHECK(MSG_SET_COLOR == V_serverMessageType_SET_COLOR, "MSG_SET_COLOR");
  CHECK(MSG_SET_WIFI == V_serverMessageType_SET_WIFI, "MSG_SET_WIFI");
  CHECK(MSG_SET_TRANSPORT == V_serverMessageType_SET_TRANSPORT, "MSG_SET_TRANSPORT");
  CHECK(MSG_GET_STATUS == V_serverMessageType_GET_STATUS, "MSG_GET_STATUS");
  CHECK(MSG_SCAN_WIFI == V_serverMessageType_SCAN_WIFI, "MSG_SCAN_WIFI");
  CHECK(MSG_RELAY == V_serverMessageType_RELAY, "MSG_RELAY");
  CHECK(MSG_SET_BRIDGE == V_serverMessageType_SET_BRIDGE, "MSG_SET_BRIDGE");

  CHECK(TRANSPORT_NOTX == V_transport_NOTX, "TRANSPORT_NOTX");
  CHECK(TRANSPORT_WIFI == V_transport_WIFI, "TRANSPORT_WIFI");
  CHECK(TRANSPORT_ESPNOW == V_transport_ESPNOW, "TRANSPORT_ESPNOW");
  CHECK(WIFI_STATE_IDLE == V_wifiState_IDLE, "WIFI_STATE_IDLE");
  CHECK(WIFI_STATE_JOINING == V_wifiState_JOINING, "WIFI_STATE_JOINING");
  CHECK(WIFI_STATE_CONNECTED == V_wifiState_CONNECTED, "WIFI_STATE_CONNECTED");
  CHECK(WIFI_STATE_FAILED == V_wifiState_FAILED, "WIFI_STATE_FAILED");
  CHECK(LOG_LEVEL_INFO == V_logLevel_INFO, "LOG_LEVEL_INFO");
  CHECK(LOG_LEVEL_WARN == V_logLevel_WARN, "LOG_LEVEL_WARN");
  CHECK(LOG_LEVEL_ERROR == V_logLevel_ERROR, "LOG_LEVEL_ERROR");

  const uint8_t live[] = {COLOR_LIVE}, preview[] = {COLOR_PREVIEW}, idle[] = {COLOR_IDLE},
                disconnected[] = {COLOR_DISCONNECTED};
  CHECK(sameBytes(live, 3, Bytes{V_colors_live}), "COLOR_LIVE");
  CHECK(sameBytes(preview, 3, Bytes{V_colors_preview}), "COLOR_PREVIEW");
  CHECK(sameBytes(idle, 3, Bytes{V_colors_idle}), "COLOR_IDLE");
  CHECK(sameBytes(disconnected, 3, Bytes{V_colors_disconnected}), "COLOR_DISCONNECTED");

  CHECK(DEFAULT_BRIGHTNESS == V_DEFAULT_BRIGHTNESS, "DEFAULT_BRIGHTNESS");
  CHECK(MAX_PAYLOAD_BYTES == V_MAX_PAYLOAD_BYTES, "MAX_PAYLOAD_BYTES");
  CHECK(ESPNOW_CHANNEL == V_ESPNOW_CHANNEL, "ESPNOW_CHANNEL");
  CHECK(ESPNOW_CHANNEL_MIN == V_ESPNOW_CHANNEL_MIN, "ESPNOW_CHANNEL_MIN");
  CHECK(ESPNOW_CHANNEL_MAX == V_ESPNOW_CHANNEL_MAX, "ESPNOW_CHANNEL_MAX");
  CHECK(WIFI_SSID_MAX_BYTES == V_WIFI_SSID_MAX_BYTES, "WIFI_SSID_MAX_BYTES");
  CHECK(WIFI_PASSWORD_MAX_BYTES == V_WIFI_PASSWORD_MAX_BYTES, "WIFI_PASSWORD_MAX_BYTES");
  CHECK(HEARTBEAT_INTERVAL_MS == V_HEARTBEAT_INTERVAL_MS, "HEARTBEAT_INTERVAL_MS");
  CHECK(DISCOVERY_INTERVAL_MS == V_DISCOVERY_INTERVAL_MS, "DISCOVERY_INTERVAL_MS");
  CHECK(HOST_SILENCE_TIMEOUT_MS == V_HOST_SILENCE_TIMEOUT_MS, "HOST_SILENCE_TIMEOUT_MS");
}

int main() {
  checkConstants();
  int checked = runVectors();
  if (g_failures) {
    fprintf(stderr, "%d protocol.h check(s) failed\n", g_failures);
    return 1;
  }
  printf("protocol.h matches the shared vectors (%d vectors)\n", checked);
  return 0;
}

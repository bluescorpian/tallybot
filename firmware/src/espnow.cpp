#include "espnow.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <string.h>

#include "indicators.h"
#include "log.h"
#include "settings.h"
#include "usb.h"
#include "wifi.h"

namespace {
const uint8_t kBroadcast[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
constexpr unsigned long kHelloIntervalMs = 1000;  // re-send HELLO until the first bridge frame

// Which role owns the radio right now. The single RX callback dispatches on this — a frame
// means "discovery/colour from the bridge" to a light, "discovery/relay-up" to a bridge.
enum class Role { NONE, LIGHT, BRIDGE };
Role g_role = Role::NONE;

uint8_t g_mac[6];
espnow::MessageHandler g_handler = nullptr;

// The 2.4GHz channel the radio is pinned to right now: the light's persisted channel, or the
// bridge's SET_BRIDGE channel. Peers are added on this channel. Defaults to the compiled constant.
uint8_t g_channel = ESPNOW_CHANNEL;

// ── Inbound ring buffer ────────────────────────────────────────────────────────
// The ESP-NOW recv callback runs off the main loop; it only copies frames here. The loop drains
// them so FastLED / usb::send() never run in callback context. Our frames are tiny (≤ 12 B) and
// discovery strings 10 B, so a small per-slot cap is ample; an over-long frame is dropped.
constexpr size_t kMaxFrame = 32;
constexpr size_t kRingSlots = 8;
struct Frame {
  uint8_t src[6];
  uint8_t len;
  uint8_t data[kMaxFrame];
};
volatile Frame g_ring[kRingSlots];
volatile size_t g_ringHead = 0;  // written by the loop (drain)
volatile size_t g_ringTail = 0;  // written by the callback (enqueue)

void enqueue(const uint8_t* src, const uint8_t* data, int len) {
  if (len <= 0 || (size_t)len > kMaxFrame) return;
  size_t next = (g_ringTail + 1) % kRingSlots;
  if (next == g_ringHead) return;  // full — drop (the keyframe re-asserts within ~1s)
  volatile Frame& f = g_ring[g_ringTail];
  memcpy((void*)f.src, src, 6);
  f.len = (uint8_t)len;
  memcpy((void*)f.data, data, len);
  g_ringTail = next;
}

bool dequeue(Frame* out) {
  if (g_ringHead == g_ringTail) return false;
  volatile Frame& f = g_ring[g_ringHead];
  memcpy(out->src, (const void*)f.src, 6);
  out->len = f.len;
  memcpy(out->data, (const void*)f.data, f.len);
  g_ringHead = (g_ringHead + 1) % kRingSlots;
  return true;
}

// A discovery string starts with ASCII 'T' (0x54), outside the binary type-byte range.
bool isDiscovery(const uint8_t* data, size_t len, const char* str) {
  size_t n = strlen(str);
  return len == n && memcmp(data, str, n) == 0;
}

// The light matches the bridge's reply by prefix only: the bridge unicasts the same
// "TALLY_HERE:<port>" the UDP server sends, but the port is meaningless over ESP-NOW.
bool isDiscoveryPrefix(const uint8_t* data, size_t len, const char* prefix) {
  size_t n = strlen(prefix);
  return len >= n && memcmp(data, prefix, n) == 0;
}

bool addPeer(const uint8_t* mac) {
  if (esp_now_is_peer_exist(mac)) return true;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  peer.channel = g_channel;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  return esp_now_add_peer(&peer) == ESP_OK;
}

void recvCb(const uint8_t* mac, const uint8_t* data, int len) { enqueue(mac, data, len); }

// ── Light role state ───────────────────────────────────────────────────────────
uint8_t g_bridge[6];          // the bridge we linked to (valid while g_linked)
bool g_linked = false;        // registered the bridge as a peer + handed off discovery
bool g_gotFrame = false;      // received the first frame from the bridge (stops HELLO re-send)
bool g_everHadBridge = false; // splits "first hunt" (cyan) from "lost the bridge" (steady blue)
unsigned long g_lastBroadcast = 0;
unsigned long g_lastHello = 0;
unsigned long g_lastHeartbeat = 0;
unsigned long g_lastRx = 0;

void sendRaw(const uint8_t* peer, const uint8_t* payload, size_t len) {
  esp_now_send(peer, payload, len);  // fire-and-forget; the keyframe covers loss
}

void radioUp() {
  wifi::espnowRadioUp(g_channel);
  if (esp_now_init() != ESP_OK) {
    TLOG(LOG_LEVEL_ERROR, "esp_now_init failed\n");
    return;
  }
  esp_now_register_recv_cb(recvCb);
}

void radioDown() {
  esp_now_deinit();
  g_ringHead = g_ringTail = 0;  // drop anything the callback queued mid-teardown
}

// Drop the bridge link and fall back to searching. The LED follows the tally.cpp pattern: cyan
// while still hunting for a first bridge, steady blue once we've held a link and lost it.
void resetLink() {
  if (g_linked) esp_now_del_peer(g_bridge);
  g_linked = false;
  g_gotFrame = false;
  if (g_everHadBridge)
    ind::lostServer();  // steady blue — we lost the bridge (LED.md state 10)
  else
    ind::searching();   // cyan pulse — never linked yet (state 4)
}
}  // namespace

void espnow::init(const uint8_t mac[6], MessageHandler onMessage) {
  memcpy(g_mac, mac, 6);
  g_handler = onMessage;
}

// ── Light role ──────────────────────────────────────────────────────────────────

void espnow::startLight() {
  g_channel = settings::espnowChannel();  // the persisted channel (default ESPNOW_CHANNEL)
  radioUp();
  g_role = Role::LIGHT;
  g_lastBroadcast = millis() - DISCOVERY_INTERVAL_MS;  // broadcast on the next tick
  resetLink();
  TLOG(LOG_LEVEL_INFO, "ESP-NOW light: searching for a bridge\n");
}

void espnow::stopLight() {
  if (g_role != Role::LIGHT) return;
  radioDown();
  g_role = Role::NONE;
}

void espnow::loopLight(unsigned long now) {
  // Drain inbound frames first — any frame from the bridge is liveness + (usually) a SET_COLOR.
  Frame f;
  while (dequeue(&f)) {
    if (isDiscoveryPrefix(f.data, f.len, DISCOVERY_RESPONSE_PREFIX)) {  // ignore the port suffix
      if (!g_linked) {  // a bridge answered — register it as our single peer and say HELLO
        memcpy(g_bridge, f.src, 6);
        if (addPeer(g_bridge)) {
          g_linked = true;
          g_everHadBridge = true;
          g_gotFrame = false;
          g_lastRx = now;
          g_lastHello = now - kHelloIntervalMs;  // HELLO on the next tick
          ind::unassigned();  // white breathe until the first SET_COLOR (state-5 hand-off)
          TLOG(LOG_LEVEL_INFO, "Linked to bridge %02x:%02x:%02x:%02x:%02x:%02x\n", g_bridge[0],
               g_bridge[1], g_bridge[2], g_bridge[3], g_bridge[4], g_bridge[5]);
        }
      }
      continue;
    }
    // A binary frame from our bridge: decode + dispatch like any other transport.
    if (g_linked && memcmp(f.src, g_bridge, 6) == 0) {
      g_lastRx = now;
      g_gotFrame = true;
      ServerMessage msg;
      if (decodeServerMessage(f.data, f.len, &msg) && g_handler) g_handler(msg);
    }
  }

  if (!g_linked) {  // searching: broadcast TALLY_FIND until a bridge answers
    if (now - g_lastBroadcast >= DISCOVERY_INTERVAL_MS) {
      g_lastBroadcast = now;
      if (!esp_now_is_peer_exist(kBroadcast)) addPeer(kBroadcast);
      sendRaw(kBroadcast, (const uint8_t*)DISCOVERY_REQUEST, strlen(DISCOVERY_REQUEST));
    }
    return;
  }

  // Linked: no traffic for the timeout means the bridge is gone — drop the link, resume discovery.
  if (now - g_lastRx >= ESPNOW_LINK_TIMEOUT_MS) {
    TLOG(LOG_LEVEL_WARN, "Bridge link timed out; resuming discovery\n");
    g_lastBroadcast = now - DISCOVERY_INTERVAL_MS;
    resetLink();
    return;
  }

  if (!g_gotFrame) {  // re-send HELLO every 1s until the bridge's first frame arrives
    if (now - g_lastHello >= kHelloIntervalMs) {
      g_lastHello = now;
      uint8_t hello[8];
      sendRaw(g_bridge, hello, encodeHelloPayload(hello, g_mac));
    }
    return;
  }

  if (now - g_lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    g_lastHeartbeat = now;
    uint8_t hb[1] = {MSG_HEARTBEAT};  // raw payload per datagram — no length prefix, no COBS
    sendRaw(g_bridge, hb, sizeof(hb));
  }
}

// ── Bridge role ───────────────────────────────────────────────────────────────────

void espnow::enterBridge(uint8_t channel) {
  if (g_role == Role::BRIDGE) return;
  if (g_role == Role::LIGHT) radioDown();  // a cabled ESPNOW light becomes a bridge — rebuild fresh
  g_channel = channel;      // pin to the SET_BRIDGE channel (runtime-only — not persisted)
  wifi::dropAssociation();  // a warm STA association would drag the radio off the pinned channel
  radioUp();
  g_role = Role::BRIDGE;
  TLOG(LOG_LEVEL_INFO, "Bridge mode on (channel %u)\n", channel);
}

void espnow::exitBridge() {
  if (g_role != Role::BRIDGE) return;
  radioDown();
  g_role = Role::NONE;
  TLOG(LOG_LEVEL_INFO, "Bridge mode off; restoring radio per transport mode\n");
  // Restore the radio to what the device's own NVS transport mode dictates. main.cpp's per-tick
  // service then resumes the matching client (WiFi tally / ESP-NOW light) as needed.
  switch (settings::transportMode()) {
    case TRANSPORT_WIFI:
      wifi::enableRadio();
      wifi::beginAssociation();  // resume the warm association
      break;
    case TRANSPORT_ESPNOW:
      // main.cpp restarts the light role on the next tick (when unplugged); nothing to do here.
      break;
    default:  // TRANSPORT_NOTX
      wifi::disableRadio();
      break;
  }
}

bool espnow::bridgeActive() { return g_role == Role::BRIDGE; }

// No clock: the bridge is stateless in time — it drains the ring and answers discovery; liveness
// is the sidecar's job (the spec's "the bridge tracks nothing about liveness").
void espnow::loopBridge() {
  Frame f;
  while (dequeue(&f)) {
    if (isDiscovery(f.data, f.len, DISCOVERY_REQUEST)) {  // a light is hunting — adopt + answer
      if (!addPeer(f.src)) {  // table full (ESP-NOW caps at 20) — no eviction in v1.3
        TLOG(LOG_LEVEL_WARN, "Peer table full; dropping TALLY_FIND\n");
        continue;
      }
      // Reply with the very same "TALLY_HERE:<port>" the UDP server sends (one format on both
      // transports). The light prefix-matches and ignores the port — meaningless over ESP-NOW.
      char here[24];
      int n = snprintf(here, sizeof(here), "%s%d", DISCOVERY_RESPONSE_PREFIX, SERVER_PORT);
      sendRaw(f.src, (const uint8_t*)here, (size_t)n);
      continue;
    }
    // Any other peer frame: wrap as RELAY-up [type][srcMAC×6][inner…] and forward up the USB pipe,
    // unread. srcMAC comes from the receive callback so MAC-less inner payloads stay attributable.
    uint8_t out[7 + kMaxFrame];
    out[0] = MSG_RELAY_UP;
    memcpy(&out[1], f.src, 6);
    memcpy(&out[7], f.data, f.len);
    usb::send(out, 7 + f.len);
  }
}

void espnow::relay(const ServerMessage& msg) {
  if (g_role != Role::BRIDGE || msg.kind != ServerMessage::RELAY) return;
  // Drop silently if the target isn't a registered peer — the light's re-discovery + keyframe
  // recover. We never register the target here (the peer table is owned by discovery).
  if (!esp_now_is_peer_exist(msg.targetMac)) return;
  sendRaw(msg.targetMac, msg.inner, msg.innerLen);
}

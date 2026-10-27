#include "espnow.h"

#include <Arduino.h>
#include <WiFi.h>
#include <atomic>
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
constexpr unsigned long kHelloIntervalMs = 1000;  // HELLO cadence: awaiting the first frame, or relinking
constexpr unsigned long kRadioRetryMs = 5000;     // a light whose radio failed to come up tries again this often

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
// them so FastLED / usb::send() never run in callback context. Our frames are tiny (≤ 12 B),
// discovery strings 10 B, and a light's LOG is capped to fit, so a small per-slot cap is ample;
// an over-long frame is dropped.
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
  if (next == g_ringHead) return;  // full — drop (the next keyframe, ≤ 250 ms away, re-asserts)
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

// ── Bridge diagnostics ────────────────────────────────────────────────────────────
// Per-window counters the bridge summarises once a second, to tell apart why a light drops to
// "lost the bridge": the host stopped sending (relayIn 0), the target wasn't a peer (noPeer), the
// send queue filled (noMem), or the radio lost frames (ackFail). The send callback runs in the
// WiFi task, so the counters it bumps are atomics and it never logs; the loop swaps them to 0.
constexpr unsigned long kBridgeStatsMs = 1000;
std::atomic<uint32_t> g_relayIn{0};    // RELAYs received from the host
std::atomic<uint32_t> g_noPeer{0};     // RELAYs dropped: target isn't a registered peer
std::atomic<uint32_t> g_peerFull{0};   // TALLY_FINDs dropped: the peer table is full (that light never links)
std::atomic<uint32_t> g_txOk{0};       // esp_now_send accepted the frame
std::atomic<uint32_t> g_txNoMem{0};    // ESP_ERR_ESPNOW_NO_MEM: the send queue is full
std::atomic<uint32_t> g_txNotFound{0}; // ESP_ERR_ESPNOW_NOT_FOUND
std::atomic<uint32_t> g_txIfErr{0};    // ESP_ERR_ESPNOW_IF
std::atomic<uint32_t> g_txOther{0};    // any other error; the last one's code is in g_txOtherCode
std::atomic<int32_t> g_txOtherCode{0};
std::atomic<uint32_t> g_ackOk{0};      // send callback: the peer MAC-ACKed
std::atomic<uint32_t> g_ackFail{0};    // send callback: no MAC ACK after retries (radio loss)
volatile uint8_t g_ackFailMac[6];      // the last target that missed an ACK (best effort)
unsigned long g_lastBridgeStats = 0;

void sendCb(const uint8_t* mac, esp_now_send_status_t status) {
  if (status == ESP_NOW_SEND_SUCCESS) {
    g_ackOk.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  g_ackFail.fetch_add(1, std::memory_order_relaxed);
  if (mac)
    for (int i = 0; i < 6; i++) g_ackFailMac[i] = mac[i];
}

void countSendResult(esp_err_t err) {
  switch (err) {
    case ESP_OK: g_txOk.fetch_add(1, std::memory_order_relaxed); break;
    case ESP_ERR_ESPNOW_NO_MEM: g_txNoMem.fetch_add(1, std::memory_order_relaxed); break;
    case ESP_ERR_ESPNOW_NOT_FOUND: g_txNotFound.fetch_add(1, std::memory_order_relaxed); break;
    case ESP_ERR_ESPNOW_IF: g_txIfErr.fetch_add(1, std::memory_order_relaxed); break;
    default:
      g_txOther.fetch_add(1, std::memory_order_relaxed);
      g_txOtherCode.store(err, std::memory_order_relaxed);
      break;
  }
}

uint32_t take(std::atomic<uint32_t>& counter) { return counter.exchange(0, std::memory_order_relaxed); }

// One line per window, zeros included: a window with no RELAYs in is itself the signal.
void logBridgeStats() {
  uint32_t in = take(g_relayIn), noPeer = take(g_noPeer), peerFull = take(g_peerFull), ok = take(g_txOk),
           noMem = take(g_txNoMem), notFound = take(g_txNotFound), ifErr = take(g_txIfErr),
           other = take(g_txOther), ackOk = take(g_ackOk), ackFail = take(g_ackFail);
  bool trouble = noPeer || peerFull || noMem || notFound || ifErr || other || ackFail;
  char lastFail[40] = "";
  if (ackFail)
    snprintf(lastFail, sizeof(lastFail), " last_ack_fail=%02x:%02x:%02x:%02x:%02x:%02x", g_ackFailMac[0],
             g_ackFailMac[1], g_ackFailMac[2], g_ackFailMac[3], g_ackFailMac[4], g_ackFailMac[5]);
  char otherCode[24] = "";
  if (other) snprintf(otherCode, sizeof(otherCode), " (last 0x%lx)", (long)g_txOtherCode.load());
  TLOG(trouble ? LOG_LEVEL_WARN : LOG_LEVEL_INFO,
       "bridge 1s: relay_in=%lu no_peer=%lu peer_full=%lu tx_ok=%lu no_mem=%lu not_found=%lu if_err=%lu "
       "other=%lu%s ack_ok=%lu ack_fail=%lu%s\n",
       (unsigned long)in, (unsigned long)noPeer, (unsigned long)peerFull, (unsigned long)ok, (unsigned long)noMem,
       (unsigned long)notFound, (unsigned long)ifErr, (unsigned long)other, otherCode,
       (unsigned long)ackOk, (unsigned long)ackFail, lastFail);
}

void resetBridgeStats(unsigned long now) {
  for (auto* c : {&g_relayIn, &g_noPeer, &g_peerFull, &g_txOk, &g_txNoMem, &g_txNotFound, &g_txIfErr, &g_txOther,
                  &g_ackOk, &g_ackFail})
    c->store(0, std::memory_order_relaxed);
  g_lastBridgeStats = now;
}

// ── Light role state ───────────────────────────────────────────────────────────
// The light keeps at most one bridge peer. A link timeout doesn't forget it: the light shows
// lost-bridge blue and resumes discovery (another bridge may have been designated), but keeps the
// bridge as a peer, so the next decodable frame from it relinks at once (the bridge keeps
// relaying keyframes while the sidecar still has the light online) and a HELLO unicast to it gets
// a sidecar that did drop the light sending again. Only a TALLY_HERE from a different bridge
// replaces it — the old peer is deleted then, so the peer table never holds a stale bridge.
uint8_t g_bridge[6];          // our bridge (valid while g_haveBridge)
bool g_haveBridge = false;    // g_bridge is registered as a peer (linked, or remembered after a timeout)
bool g_linked = false;        // the link to g_bridge is live (a frame within HOST_SILENCE_TIMEOUT_MS)
bool g_gotFrame = false;      // received the first frame from the bridge (stops HELLO re-send)
bool g_everHadBridge = false; // splits "first hunt" (cyan) from "lost the bridge" (steady blue)
unsigned long g_lastBroadcast = 0;
unsigned long g_lastHello = 0;
unsigned long g_lastHeartbeat = 0;
unsigned long g_lastRx = 0;   // the last frame from the bridge; across an outage, its start
uint32_t g_linkTimeouts = 0;  // link timeouts since boot, reported with each relink
bool g_inOutage = false;      // a link timed out and hasn't been restored yet (a relink reports it)
bool g_radioFailed = false;   // the light's radio didn't come up; retried every kRadioRetryMs
unsigned long g_lastRadioTry = 0;

void sendRaw(const uint8_t* peer, const uint8_t* payload, size_t len) {
  // Fire-and-forget; the keyframe covers loss. The result only feeds the bridge's diagnostics.
  countSendResult(esp_now_send(peer, payload, len));
}

// False if any step failed, with ESP-NOW left uninitialised: a caller must not take a role on a radio
// that can't send or receive (a light would hunt forever, a bridge would report itself active).
bool radioUp() {
  if (!wifi::espnowRadioUp(g_channel)) return false;
  esp_err_t err = esp_now_init();
  if (err != ESP_OK) {
    TLOG(LOG_LEVEL_ERROR, "esp_now_init failed: 0x%x\n", (unsigned)err);
    return false;
  }
  if (esp_now_register_recv_cb(recvCb) != ESP_OK || esp_now_register_send_cb(sendCb) != ESP_OK) {
    TLOG(LOG_LEVEL_ERROR, "esp_now callback registration failed\n");
    esp_now_deinit();
    return false;
  }
  return true;
}

void radioDown() {
  esp_now_deinit();
  g_ringHead = g_ringTail = 0;  // drop anything the callback queued mid-teardown
}

// Mark the link down and fall back to searching, keeping any remembered bridge peer. The LED
// follows the tally.cpp pattern: cyan while still hunting for a first bridge, steady blue once
// we've held a link and lost it.
void unlink() {
  g_linked = false;
  g_gotFrame = false;
  if (g_everHadBridge)
    ind::lostServer();  // steady blue — we lost the bridge (docs/led.md state 10)
  else
    ind::searching();   // cyan pulse — never linked yet (state 4)
}

// Report the outage a relink just ended, to the bridge (which relays it up as any peer frame) and
// to the local log. The text stays ≤ 30 B so the LOG payload fits the bridge ring's kMaxFrame.
void reportRelink(unsigned long now) {
  if (!g_inOutage) return;
  g_inOutage = false;
  char text[31];
  int n = snprintf(text, sizeof(text), "relink gap %lums timeout#%lu", (unsigned long)(now - g_lastRx),
                   (unsigned long)g_linkTimeouts);
  if (n < 0) return;
  size_t len = (size_t)n < sizeof(text) ? (size_t)n : sizeof(text) - 1;
  uint8_t frame[kMaxFrame];
  sendRaw(g_bridge, frame, encodeLogPayload(frame, sizeof(frame), LOG_LEVEL_WARN, text, len));
  TLOG(LOG_LEVEL_WARN, "%s\n", text);
}

// Adopt `mac` as our bridge peer, replacing (and deleting) a different remembered one.
bool adoptBridge(const uint8_t* mac) {
  if (g_haveBridge && memcmp(g_bridge, mac, 6) == 0) return true;
  if (g_haveBridge) esp_now_del_peer(g_bridge);
  g_haveBridge = false;
  memcpy(g_bridge, mac, 6);
  if (!addPeer(g_bridge)) return false;
  g_haveBridge = true;
  return true;
}

// Put the radio back the way the device's own NVS transport mode needs it. main.cpp's per-tick
// service then resumes the matching client (WiFi tally / ESP-NOW light) as needed.
void restoreRadio() {
  switch (settings::transportMode()) {
    case TRANSPORT_WIFI:
      wifi::enableRadio();
      wifi::beginAssociation();  // resume the warm association
      break;
    case TRANSPORT_ESPNOW:
      // main.cpp's startTransportClient restarts the light role; nothing to do here.
      break;
    default:  // TRANSPORT_NOTX
      wifi::disableRadio();
      break;
  }
}

void sendHello() {
  uint8_t hello[32];
  sendRaw(g_bridge, hello, encodeHelloPayload(hello, g_mac));
  sendRaw(g_bridge, hello, encodeFirmwarePayload(hello, sizeof(hello), FIRMWARE_VERSION));
}
}  // namespace

void espnow::init(const uint8_t mac[6], MessageHandler onMessage) {
  memcpy(g_mac, mac, 6);
  g_handler = onMessage;
}

// ── Light role ──────────────────────────────────────────────────────────────────

void espnow::startLight() {
  g_channel = settings::espnowChannel();  // the persisted channel (default ESPNOW_CHANNEL)
  g_role = Role::LIGHT;
  g_haveBridge = false;  // radioUp() starts with an empty peer table
  g_inOutage = false;
  g_lastRadioTry = millis();
  if (!radioUp()) {
    // No host can hear this light, so the LED is the only report: magenta blink ("check the
    // device"), not the cyan hunt, which would look healthy. loopLight retries.
    g_radioFailed = true;
    ind::radioFailed();
    return;
  }
  g_radioFailed = false;
  g_lastBroadcast = millis() - DISCOVERY_INTERVAL_MS;  // broadcast on the next tick
  unlink();
  TLOG(LOG_LEVEL_INFO, "ESP-NOW light: searching for a bridge\n");
}

void espnow::stopLight() {
  if (g_role != Role::LIGHT) return;
  if (!g_radioFailed) radioDown();
  g_radioFailed = false;
  g_role = Role::NONE;
}

void espnow::loopLight(unsigned long now) {
  if (g_radioFailed) {
    if (millis() - g_lastRadioTry >= kRadioRetryMs) startLight();  // millis(): startLight stamps it, maybe after `now`
    return;
  }
  // Drain inbound frames first — any frame from the bridge is liveness + (usually) a SET_COLOR.
  Frame f;
  while (dequeue(&f)) {
    if (isDiscoveryPrefix(f.data, f.len, DISCOVERY_RESPONSE_PREFIX)) {  // ignore the port suffix
      if (!g_linked) {  // a bridge answered — make it our single peer and say HELLO
        if (!adoptBridge(f.src)) continue;
        g_linked = true;
        g_everHadBridge = true;
        g_gotFrame = false;
        reportRelink(now);  // before g_lastRx moves: the gap runs from the last frame to this one
        g_lastRx = now;
        g_lastHello = now - kHelloIntervalMs;  // HELLO on the next tick
        ind::unassigned();  // white breathe until the first SET_COLOR (state-5 hand-off)
        TLOG(LOG_LEVEL_INFO, "Linked to bridge %02x:%02x:%02x:%02x:%02x:%02x\n", g_bridge[0],
             g_bridge[1], g_bridge[2], g_bridge[3], g_bridge[4], g_bridge[5]);
      }
      continue;
    }
    // A binary frame from our bridge: decode + dispatch like any other transport.
    if (!g_haveBridge || memcmp(f.src, g_bridge, 6) != 0) continue;
    ServerMessage msg;
    bool decoded = decodeServerMessage(f.data, f.len, &msg);
    if (!g_linked) {
      // Fast relink: the remembered bridge is still relaying to us, so a decodable frame is proof
      // enough — restore the link without waiting on TALLY_HERE + a HELLO round-trip.
      if (!decoded) continue;
      g_linked = true;
      reportRelink(now);
      TLOG(LOG_LEVEL_INFO, "Relinked to bridge on a relayed frame\n");
    }
    g_lastRx = now;
    g_gotFrame = true;
    if (decoded && g_handler) g_handler(msg);
  }

  if (!g_linked) {  // searching: broadcast TALLY_FIND until a bridge answers
    if (now - g_lastBroadcast >= DISCOVERY_INTERVAL_MS) {
      g_lastBroadcast = now;
      if (!esp_now_is_peer_exist(kBroadcast)) addPeer(kBroadcast);
      sendRaw(kBroadcast, (const uint8_t*)DISCOVERY_REQUEST, strlen(DISCOVERY_REQUEST));
    }
    // ...and HELLO the remembered bridge, so a sidecar that dropped us re-learns us and resumes
    // sending without depending on a broadcast getting through.
    if (g_haveBridge && now - g_lastHello >= kHelloIntervalMs) {
      g_lastHello = now;
      sendHello();
    }
    return;
  }

  // Linked: no traffic for the timeout means the link is down — show it and resume discovery,
  // remembering the bridge for a fast relink.
  if (now - g_lastRx >= HOST_SILENCE_TIMEOUT_MS) {
    g_linkTimeouts++;
    g_inOutage = true;
    TLOG(LOG_LEVEL_WARN, "Bridge link timed out (#%lu); resuming discovery\n", (unsigned long)g_linkTimeouts);
    g_lastBroadcast = now - DISCOVERY_INTERVAL_MS;
    g_lastHello = now - kHelloIntervalMs;
    unlink();
    return;
  }

  if (!g_gotFrame) {  // re-send HELLO every 1s until the bridge's first frame arrives
    if (now - g_lastHello >= kHelloIntervalMs) {
      g_lastHello = now;
      sendHello();
    }
    return;
  }

  if (now - g_lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    g_lastHeartbeat = now;
    uint8_t hb[1] = {MSG_HEARTBEAT};  // raw payload per datagram — no length prefix, no COBS
    sendRaw(g_bridge, hb, sizeof(hb));
    // FIRMWARE again: the ones sent with HELLO are fire-and-forget too, and a lost one would
    // leave the app not knowing this light's firmware for the whole session.
    uint8_t fw[32];
    sendRaw(g_bridge, fw, encodeFirmwarePayload(fw, sizeof(fw), FIRMWARE_VERSION));
  }
}

// ── Bridge role ───────────────────────────────────────────────────────────────────

void espnow::enterBridge(uint8_t channel) {
  if (g_role == Role::BRIDGE) return;
  if (g_role == Role::LIGHT) radioDown();  // a cabled ESPNOW light becomes a bridge — rebuild fresh
  g_channel = channel;      // pin to the SET_BRIDGE channel (runtime-only — not persisted)
  wifi::dropAssociation();  // a warm STA association would drag the radio off the pinned channel
  if (!radioUp()) {
    // Stay out of the bridge role so STATUS reports bridging=0 and the host doesn't count it as
    // confirmed, and put the radio back the way the device's own mode needs it.
    g_role = Role::NONE;
    restoreRadio();
    TLOG(LOG_LEVEL_ERROR, "Bridge mode failed: radio didn't come up on channel %u\n", channel);
    return;
  }
  resetBridgeStats(millis());  // the light role's sends also bumped the counters
  g_role = Role::BRIDGE;
  TLOG(LOG_LEVEL_INFO, "Bridge mode on (channel %u)\n", channel);
}

void espnow::exitBridge() {
  if (g_role != Role::BRIDGE) return;
  radioDown();
  g_role = Role::NONE;
  TLOG(LOG_LEVEL_INFO, "Bridge mode off; restoring radio per transport mode\n");
  // Restore the radio to what the device's own NVS transport mode dictates. main.cpp's
  // startTransportClient(..., Resume::RADIO_RESTORED) then resumes the matching client.
  restoreRadio();
}

bool espnow::bridgeActive() { return g_role == Role::BRIDGE; }

// The bridge is stateless in time — it drains the ring and answers discovery; liveness is the
// sidecar's job (the spec's "the bridge tracks nothing about liveness"). `now` only paces the
// once-a-second diagnostics summary.
void espnow::loopBridge(unsigned long now) {
  if (now - g_lastBridgeStats >= kBridgeStatsMs) {
    g_lastBridgeStats = now;
    logBridgeStats();
  }

  Frame f;
  while (dequeue(&f)) {
    if (isDiscovery(f.data, f.len, DISCOVERY_REQUEST)) {  // a light is hunting — adopt + answer
      if (!addPeer(f.src)) {  // table full (ESP-NOW caps at 20) — no eviction in v1.3
        g_peerFull.fetch_add(1, std::memory_order_relaxed);  // reported in the 1 s stats line
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
  g_relayIn.fetch_add(1, std::memory_order_relaxed);
  // Drop if the target isn't a registered peer (counted, not logged) — the light's re-discovery +
  // keyframe recover. We never register the target here (the peer table is owned by discovery).
  if (!esp_now_is_peer_exist(msg.targetMac)) {
    g_noPeer.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  sendRaw(msg.targetMac, msg.inner, msg.innerLen);
}

#include "espnow.h"

#include <Arduino.h>
#include <WiFi.h>
#include <atomic>
#include <esp_now.h>
#include <esp_wifi.h>
#include <string.h>

#include "indicators.h"
#include "log.h"
#include "scan.h"
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

// The 2.4GHz channel the radio is tuned to right now: the light's persisted channel (or, mid-hunt,
// the channel it is listening on), or the bridge's SET_BRIDGE channel. Peers are added with
// channel 0, which esp_now.h defines as "the channel the interface is on now", so a retune moves
// them along without re-adding them.
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

// Parse a bridge's reply (protocol.h, Discovery): "TALLY_HERE:<port>" from a v3 bridge (*channel
// = 0: link on whatever channel the radio is on) or "TALLY_HERE:<port>:<channel>" from a v4 one.
// False for anything else, including a channel outside ESPNOW_CHANNEL_MIN..MAX. The port is skipped.
bool parseHere(const uint8_t* data, size_t len, uint8_t* channel) {
  size_t i = strlen(DISCOVERY_RESPONSE_PREFIX);
  if (len < i || memcmp(data, DISCOVERY_RESPONSE_PREFIX, i) != 0) return false;
  size_t portStart = i;
  while (i < len && data[i] >= '0' && data[i] <= '9') i++;
  if (i == portStart) return false;
  *channel = 0;
  if (i == len) return true;
  if (data[i++] != ':') return false;
  unsigned ch = 0;
  size_t chStart = i;
  while (i < len && i - chStart < 2 && data[i] >= '0' && data[i] <= '9') ch = ch * 10 + (data[i++] - '0');
  if (i == chStart || i != len || !isEspnowChannel(ch)) return false;
  *channel = (uint8_t)ch;
  return true;
}

bool addPeer(const uint8_t* mac) {
  if (esp_now_is_peer_exist(mac)) return true;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  peer.channel = 0;  // follow the radio's current channel (see g_channel)
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  return esp_now_add_peer(&peer) == ESP_OK;
}

void recvCb(const uint8_t* mac, const uint8_t* data, int len) { enqueue(mac, data, len); }

// Retune the running radio. Frames still queued were heard on the old channel, so they're dropped:
// a light must not credit a TALLY_HERE to the channel it has just moved to. (The callback only
// advances the tail, so moving the head up to it from the loop is a safe flush.) `quiet` leaves a
// refusal unlogged, for a caller that retries until the radio accepts.
bool tune(uint8_t channel, bool quiet = false) {
  esp_err_t err = esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
  if (err != ESP_OK) {
    if (!quiet) TLOG(LOG_LEVEL_ERROR, "esp_wifi_set_channel(%u) failed: 0x%x\n", channel, (unsigned)err);
    return false;
  }
  g_channel = channel;
  g_ringHead = g_ringTail;
  return true;
}

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

// Channel hunt: a light unlinked for CHANNEL_HUNT_AFTER_MS sweeps 1..13 (CHANNEL_DWELL_MS each,
// one TALLY_FIND per channel), then spends one DISCOVERY_INTERVAL_MS back on its home channel,
// and repeats until a bridge answers. A linked light follows a channel move on its bridge's
// announcement or beacon; the hunt is how one that was off or out of range then finds it. Before
// the threshold it stays on the home channel (or one a bridge it hears names), so an ordinary
// dropout relinks as before.
uint8_t g_homeChannel = ESPNOW_CHANNEL;  // the persisted channel (settings::espnowChannel)
unsigned long g_unlinkedSince = 0;       // when this outage (or the first search) began
bool g_hunting = false;                  // this outage has passed CHANNEL_HUNT_AFTER_MS
bool g_sweeping = false;                 // mid-sweep: the radio is off the home channel
uint8_t g_sweepChannel = 0;              // the channel being listened on, while g_sweeping
unsigned long g_huntPhaseStart = 0;      // the current dwell's start, or the home interval's

// Bridge transmit power last requested by SET_BRIDGE, in quarter-dBm.
uint8_t g_bridgeTxPower = BRIDGE_TX_POWER_FULL;

// ── Bridge channel move and beacon ─────────────────────────────────────────────
// A SET_BRIDGE that moves a running bridge to another channel doesn't retune at once: the bridge
// first broadcasts "TALLY_HERE:<port>:<new channel>" on the old one MOVE_ANNOUNCEMENTS times,
// MOVE_ANNOUNCE_MS apart (a broadcast gets no MAC retries, hence the repeats), so its linked lights
// follow straight away instead of hunting. A light linked one channel off, hearing the bridge
// through the overlap, never times out and so never hunts; the beacon (the same string naming the
// bridge's own channel, every DISCOVERY_INTERVAL_MS) moves it, and any light that missed every
// announcement but still hears the bridge.
using espnow::MOVE_ANNOUNCE_MS;
using espnow::MOVE_ANNOUNCEMENTS;
uint8_t g_moveTo = 0;          // the channel a pending move goes to (0: none pending)
uint8_t g_moveSent = 0;        // announcements sent for it
unsigned long g_lastAnnounce = 0;
unsigned long g_retunedAt = 0;  // when the last move retuned (bridgeSettled)
bool g_retuned = false;         // a move has retuned this bridge stint (g_retunedAt is valid)
unsigned long g_lastBeacon = 0;

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

// Set the radio's max transmit power and log what it reports back: the driver rounds a request
// to a step it supports (esp_wifi.h, esp_wifi_set_max_tx_power), so the read-back is the truth.
// On a refusal the radio keeps its previous power and so does g_bridgeTxPower.
void applyTxPower(uint8_t requested) {
  esp_err_t err = esp_wifi_set_max_tx_power((int8_t)requested);
  if (err != ESP_OK)
    TLOG(LOG_LEVEL_WARN, "TX power %u refused: 0x%x\n", requested, (unsigned)err);
  else
    g_bridgeTxPower = requested;
  int8_t applied = 0;
  if (esp_wifi_get_max_tx_power(&applied) == ESP_OK)
    TLOG(LOG_LEVEL_INFO, "TX power: requested %u, radio reports %d (quarter-dBm: %d.%02d dBm)\n", requested,
         applied, applied / 4, (applied % 4) * 25);
}

void radioDown() {
  esp_now_deinit();
  g_ringHead = g_ringTail = 0;  // drop anything the callback queued mid-teardown
}

// Mark the link down and fall back to searching, keeping any remembered bridge peer. The LED
// follows the tally.cpp pattern: cyan while still hunting for a first bridge, steady blue once
// we've held a link and lost it.
void unlink(unsigned long now) {
  g_linked = false;
  g_gotFrame = false;
  g_unlinkedSince = now;
  g_hunting = false;
  g_sweeping = false;
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

// The broadcast address is a peer like any other: it takes one of ESP_NOW_MAX_TOTAL_PEER_NUM slots.
void broadcast(const uint8_t* payload, size_t len) {
  if (!esp_now_is_peer_exist(kBroadcast)) addPeer(kBroadcast);
  sendRaw(kBroadcast, payload, len);
}

void broadcastFind() { broadcast((const uint8_t*)DISCOVERY_REQUEST, strlen(DISCOVERY_REQUEST)); }

// A bridge's "TALLY_HERE:<port>:<channel>" (protocol.h, Discovery), to one light or to all.
void sendHere(const uint8_t* peer, uint8_t channel) {
  char here[24];
  int n = snprintf(here, sizeof(here), "%s%d:%u", DISCOVERY_RESPONSE_PREFIX, SERVER_PORT, channel);
  if (memcmp(peer, kBroadcast, 6) == 0)
    broadcast((const uint8_t*)here, (size_t)n);
  else
    sendRaw(peer, (const uint8_t*)here, (size_t)n);
}

void dwellOn(uint8_t channel, unsigned long now) {
  g_sweepChannel = channel;
  g_huntPhaseStart = now;
  if (tune(channel)) broadcastFind();
}

void startSweep(unsigned long now) {
  g_sweeping = true;
  dwellOn(ESPNOW_CHANNEL_MIN, now);
}

// Advance the hunt (see g_homeChannel). True while a sweep owns this tick, so the home-channel
// discovery (broadcast + HELLO to the remembered bridge) doesn't run off-channel.
bool serviceHunt(unsigned long now) {
  // millis(), not `now`: startLight stamps g_unlinkedSince itself, maybe after the caller's `now`,
  // and `now - g_unlinkedSince` would wrap and start the hunt at once. (The phase timer below is
  // stamped only from `now`, so it compares against `now`.)
  if (!g_hunting && millis() - g_unlinkedSince < CHANNEL_HUNT_AFTER_MS) return false;
  if (!g_hunting) {
    g_hunting = true;
    TLOG(LOG_LEVEL_INFO, "No bridge for %lus; hunting channels %u-%u\n",
         (unsigned long)(CHANNEL_HUNT_AFTER_MS / 1000), ESPNOW_CHANNEL_MIN, ESPNOW_CHANNEL_MAX);
    startSweep(now);
    return true;
  }
  if (g_sweeping) {
    if (now - g_huntPhaseStart < CHANNEL_DWELL_MS) return true;
    if (g_sweepChannel < ESPNOW_CHANNEL_MAX) {
      dwellOn(g_sweepChannel + 1, now);
      return true;
    }
    // Sweep done: one discovery interval at home, running the ordinary discovery from now.
    g_sweeping = false;
    tune(g_homeChannel);
    g_huntPhaseStart = now;
    g_lastBroadcast = now - DISCOVERY_INTERVAL_MS;
    g_lastHello = now - kHelloIntervalMs;
    return false;
  }
  if (now - g_huntPhaseStart >= DISCOVERY_INTERVAL_MS) {
    startSweep(now);
    return true;
  }
  return false;
}

// Make the channel the radio is on the light's home, persisted only when it changed, so an
// ordinary relink writes nothing.
void keepChannel() {
  if (g_channel == g_homeChannel) return;
  TLOG(LOG_LEVEL_INFO, "Bridge on channel %u (stored %u); saving it\n", g_channel, g_homeChannel);
  g_homeChannel = g_channel;
  settings::setEspnowChannel(g_channel);
}

// A link came up: stop hunting, and keep the channel it came up on.
void endHunt() {
  g_hunting = false;
  g_sweeping = false;
  keepChannel();
}

// Advance a pending move (see g_moveTo). Not while a scan owns the radio: it can't be retuned then,
// and an announcement would go out on whichever channel the sweep is on. A scan waits for a move
// (espnow::bridgeSettled), so this only happens to one held past its cap or a move started mid-scan:
// the scan re-pins the old channel, and the move carries on from there.
void serviceMove() {
  if (!g_moveTo || scan::radioBusy()) return;
  // millis(), not the loop's `now`: enterBridge stamps g_lastAnnounce from inside the USB RX pump,
  // maybe after the loop-top `now`, and the unsigned subtraction would wrap.
  if (millis() - g_lastAnnounce < MOVE_ANNOUNCE_MS) return;
  g_lastAnnounce = millis();
  if (g_moveSent < MOVE_ANNOUNCEMENTS) {
    sendHere(kBroadcast, g_moveTo);
    g_moveSent++;
    return;
  }
  // One interval after the last announcement, so it has left the radio before the retune.
  uint8_t to = g_moveTo;
  g_moveTo = 0;
  if (!tune(to)) {
    // As for a failed entry: don't stay "bridging" on a channel the host didn't ask for.
    TLOG(LOG_LEVEL_ERROR, "Bridge retune to channel %u failed; leaving bridge mode\n", to);
    espnow::exitBridge();
    return;
  }
  TLOG(LOG_LEVEL_INFO, "Bridge retuned to channel %u\n", to);
  g_retunedAt = millis();
  g_retuned = true;
  g_lastBeacon = millis() - DISCOVERY_INTERVAL_MS;  // beacon on the new channel at once
}

// The periodic beacon. Not mid-move: sent on the old channel it would name the old channel, and a
// light that already followed an announcement could hear it through the overlap and turn back.
void serviceBeacon() {
  if (g_moveTo || scan::radioBusy()) return;
  if (millis() - g_lastBeacon < DISCOVERY_INTERVAL_MS) return;  // millis(): stamped off-loop too
  g_lastBeacon = millis();
  sendHere(kBroadcast, g_channel);
}
}  // namespace

void espnow::init(const uint8_t mac[6], MessageHandler onMessage) {
  memcpy(g_mac, mac, 6);
  g_handler = onMessage;
}

// ── Light role ──────────────────────────────────────────────────────────────────

void espnow::startLight() {
  g_homeChannel = settings::espnowChannel();  // the persisted channel (default ESPNOW_CHANNEL)
  if (!isEspnowChannel(g_homeChannel)) {
    // Written by older firmware, which stored any SET_TRANSPORT channel byte. The radio would refuse
    // it on every retry and the light would never reach its hunt; the default lets it hunt.
    TLOG(LOG_LEVEL_WARN, "Stored ESP-NOW channel %u is out of range; using %u\n", g_homeChannel, ESPNOW_CHANNEL);
    g_homeChannel = ESPNOW_CHANNEL;
  }
  g_channel = g_homeChannel;
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
  unlink(millis());
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
    uint8_t hereChannel;
    if (parseHere(f.data, f.len, &hereChannel)) {
      if (g_linked) {
        // Our bridge naming another channel: it is about to move there (its announcement), or we
        // are on an overlapping neighbour of its channel (its beacon). Follow it, staying linked:
        // its frames resume within the move's half second, well inside the link timeout. Another
        // bridge's TALLY_HERE is ignored while linked, so two in range can't pull the light about.
        if (hereChannel != 0 && hereChannel != g_channel && memcmp(f.src, g_bridge, 6) == 0) {
          uint8_t from = g_channel;
          if (tune(hereChannel)) {  // flushes the ring: the rest was heard on the old channel
            TLOG(LOG_LEVEL_INFO, "Bridge named channel %u; following it from %u\n", hereChannel, from);
            keepChannel();
          }
        }
        continue;
      }
      // A bridge answered (or beaconed) — make it our single peer and say HELLO. A v4 bridge names
      // its channel: we may have heard it from an overlapping neighbour, so move there first (which
      // flushes the rest of the ring, all heard on this channel).
      if (hereChannel != 0 && hereChannel != g_channel && !tune(hereChannel)) continue;
      if (!adoptBridge(f.src)) continue;
      g_linked = true;
      g_everHadBridge = true;
      g_gotFrame = false;
      endHunt();  // the radio is on the bridge's channel (named, or the one this reply was heard on)
      reportRelink(now);  // before g_lastRx moves: the gap runs from the last frame to this one
      g_lastRx = now;
      g_lastHello = now - kHelloIntervalMs;  // HELLO (and the TALLY_FIND below) on the next tick
      ind::unassigned();  // white breathe until the first SET_COLOR (state-5 hand-off)
      TLOG(LOG_LEVEL_INFO, "Linked to bridge %02x:%02x:%02x:%02x:%02x:%02x\n", g_bridge[0],
           g_bridge[1], g_bridge[2], g_bridge[3], g_bridge[4], g_bridge[5]);
      continue;
    }
    // A binary frame from our bridge: decode + dispatch like any other transport.
    if (!g_haveBridge || memcmp(f.src, g_bridge, 6) != 0) continue;
    ServerMessage msg;
    bool decoded = decodeServerMessage(f.data, f.len, &msg);
    if (!g_linked) {
      // Fast relink: the remembered bridge is still relaying to us, so a decodable frame is proof
      // enough — restore the link without waiting on TALLY_HERE + a HELLO round-trip. Not mid-sweep:
      // off the home channel the frame may come from an overlapping neighbour, and endHunt would
      // store the wrong channel; the dwell's TALLY_FIND gets a reply that names the right one.
      if (!decoded || g_sweeping) continue;
      g_linked = true;
      endHunt();
      reportRelink(now);
      TLOG(LOG_LEVEL_INFO, "Relinked to bridge on a relayed frame\n");
    }
    g_lastRx = now;
    g_gotFrame = true;
    if (decoded && g_handler) g_handler(msg);
  }

  if (!g_linked) {  // searching: broadcast TALLY_FIND until a bridge answers
    if (serviceHunt(now)) return;  // mid-sweep, listening on another channel
    if (now - g_lastBroadcast >= DISCOVERY_INTERVAL_MS) {
      g_lastBroadcast = now;
      broadcastFind();
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
    unlink(now);
    return;
  }

  if (!g_gotFrame) {  // re-send HELLO every 1s until the bridge's first frame arrives
    if (now - g_lastHello >= kHelloIntervalMs) {
      g_lastHello = now;
      // A beacon or announcement, unlike a reply, didn't answer a TALLY_FIND the bridge heard, so
      // the bridge may not have us as a peer and would drop the sidecar's frames to us. A unicast
      // TALLY_FIND registers us. Repeated with each HELLO, as a light that tuned ahead of a moving
      // bridge sends it before the bridge arrives. Its reply names the bridge's channel (or the
      // move's target), so a linked light changes nothing or follows the move.
      sendRaw(g_bridge, (const uint8_t*)DISCOVERY_REQUEST, strlen(DISCOVERY_REQUEST));
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

void espnow::enterBridge(uint8_t channel, uint8_t txPower) {
  if (!isEspnowChannel(channel)) {
    // Refused before the radio is touched; a bridge already running leaves, as for a failed retune,
    // so STATUS reports bridging=0 rather than a channel the host didn't ask for.
    TLOG(LOG_LEVEL_ERROR, "SET_BRIDGE channel %u out of range (%u-%u); not bridging\n", channel,
         ESPNOW_CHANNEL_MIN, ESPNOW_CHANNEL_MAX);
    exitBridge();
    return;
  }
  if (g_role == Role::BRIDGE) {
    // Already bridging: a re-assert with the same settings is a no-op; a new power is applied in
    // place, and a new channel is announced, then retuned in place by loopBridge (g_moveTo),
    // keeping the peer table (its channel-0 peers follow the retune).
    if (channel == g_channel) {
      // Sent back before a pending move retuned: the move is dropped. Lights that already followed
      // its announcements are left on the abandoned channel, to time out and hunt.
      if (g_moveTo) TLOG(LOG_LEVEL_INFO, "Bridge move to channel %u cancelled; staying on %u\n", g_moveTo, channel);
      g_moveTo = 0;
    } else if (channel != g_moveTo) {
      // A new target restarts the announcements, so the last ones heard name where it is going.
      g_moveTo = channel;
      g_moveSent = 0;
      g_lastAnnounce = millis() - MOVE_ANNOUNCE_MS;  // the first goes on the next tick
      TLOG(LOG_LEVEL_INFO, "Bridge moving to channel %u; announcing it on %u first\n", channel, g_channel);
    }
    if (txPower != g_bridgeTxPower) applyTxPower(txPower);
    return;
  }
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
  g_moveTo = 0;
  g_retuned = false;
  g_lastBeacon = millis() - DISCOVERY_INTERVAL_MS;  // beacon on the first tick
  g_role = Role::BRIDGE;
  TLOG(LOG_LEVEL_INFO, "Bridge mode on (channel %u)\n", channel);
  g_bridgeTxPower = BRIDGE_TX_POWER_FULL;  // radioUp brought the radio up at full power
  applyTxPower(txPower);
}

void espnow::exitBridge() {
  if (g_role != Role::BRIDGE) return;
  // Full power again before anything else uses the radio: a reduced cap is for this bridge stint only.
  if (g_bridgeTxPower != BRIDGE_TX_POWER_FULL) applyTxPower(BRIDGE_TX_POWER_FULL);
  g_bridgeTxPower = BRIDGE_TX_POWER_FULL;
  g_moveTo = 0;  // a move still announcing is abandoned with the role
  radioDown();
  g_role = Role::NONE;
  TLOG(LOG_LEVEL_INFO, "Bridge mode off; restoring radio per transport mode\n");
  // Restore the radio to what the device's own NVS transport mode dictates. main.cpp's
  // startTransportClient(..., Resume::RADIO_RESTORED) then resumes the matching client.
  restoreRadio();
}

bool espnow::bridgeActive() { return g_role == Role::BRIDGE; }

bool espnow::bridgeSettled(unsigned long settleMs) {
  if (g_role != Role::BRIDGE) return true;
  if (g_moveTo) return false;
  return !g_retuned || millis() - g_retunedAt >= settleMs;
}

// A scan sweeps the radio across channels 1–13 and nothing documents where it leaves an unassociated
// STA, so the bridge always re-pins. tune() also drops frames queued mid-sweep, heard off-channel.
// The channel the scan left is logged, to settle on hardware whether this is needed. The radio
// refuses a channel while the driver still scans, so a caller unsure the scan has ended retries
// (lastTry false: a refusal is quiet and changes nothing) before a last try that gives up.
bool espnow::repinBridge(bool lastTry) {
  if (g_role != Role::BRIDGE) return true;
  uint8_t left = 0;
  wifi_second_chan_t second;
  if (esp_wifi_get_channel(&left, &second) != ESP_OK) left = 0;
  if (!tune(g_channel, !lastTry)) {
    if (!lastTry) return false;
    // As for a failed retune: don't stay "bridging" on a channel the host didn't ask for.
    TLOG(LOG_LEVEL_ERROR, "Bridge re-pin to channel %u after the scan failed; leaving bridge mode\n", g_channel);
    exitBridge();
    return false;
  }
  TLOG(LOG_LEVEL_INFO, "Bridge back on channel %u after the scan (the scan left it on %u)\n", g_channel, left);
  return true;
}

// The bridge drains the ring, answers discovery, beacons and carries out a channel move; liveness
// is the sidecar's job (the spec's "the bridge tracks nothing about liveness"). `now` only paces
// the once-a-second diagnostics summary.
void espnow::loopBridge(unsigned long now) {
  if (now - g_lastBridgeStats >= kBridgeStatsMs) {
    g_lastBridgeStats = now;
    logBridgeStats();
  }
  serviceMove();
  if (g_role != Role::BRIDGE) return;  // the move's retune failed, and bridge mode was left
  serviceBeacon();

  Frame f;
  while (dequeue(&f)) {
    if (isDiscovery(f.data, f.len, DISCOVERY_REQUEST)) {  // a light is hunting — adopt + answer
      if (!addPeer(f.src)) {  // table full (ESP-NOW caps at 20) — no eviction in v1.3
        g_peerFull.fetch_add(1, std::memory_order_relaxed);  // reported in the 1 s stats line
        continue;
      }
      // The channel lets a light that heard this from an overlapping neighbour tune to ours before
      // it links; mid-move it names the channel the bridge is about to be on.
      sendHere(f.src, g_moveTo ? g_moveTo : g_channel);
      continue;
    }
    // Another bridge's beacon or move announcement (a second rig in range): discovery, not a peer
    // frame. Relayed up, it would be an unknown type to the sidecar's decoder.
    size_t herePrefix = strlen(DISCOVERY_RESPONSE_PREFIX);
    if (f.len >= herePrefix && memcmp(f.data, DISCOVERY_RESPONSE_PREFIX, herePrefix) == 0) continue;
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

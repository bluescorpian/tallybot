// TallyBot binary wire protocol — the device (firmware) side.
//
// This file is the C++ mirror of `app/sidecar/src/protocol.ts` (the source of truth;
// see `ARCHITECTURE.md` "Binary Message Protocol"). There is now a THIRD, minimal
// mirror in `app/src-tauri/src/usb/protocol.rs` (COBS framing + HELLO parse only).
// Keep all three in lockstep — a maintainer editing any one should find the others.
//
// Framing is **transport-specific; payloads are shared**. The `[type][fields…]`
// payloads ride unchanged over both transports; only the wrapper differs:
//   • TCP — length-prefixed: a single leading byte gives the number of payload bytes
//     that follow. One uniform loop frames any message regardless of length, which
//     lets a parser skip a message (or trailing fields) it doesn't recognise.
//       [len][payload …]      len = count of payload bytes that follow (1 byte, 0–255)
//   • USB-CDC — COBS (via PacketSerial), self-synchronising on a lone 0x00 delimiter.
//     PacketSerial applies the COBS wrapper; the encoders below build only the payload.
//
// Wire reference (exact TCP bytes; over USB the same payloads ride inside a COBS frame):
//   HELLO      08 01 02 <mac0..mac5>      (device → server)   [version is now 2]
//   HEARTBEAT  01 02                      (device → server)
//   SET_COLOR  05 01 <R> <G> <B> <bri>    (server → device)
//   STATUS/LOG and SET_WIFI/SET_TRANSPORT/GET_STATUS are USB-only — see below.

#pragma once

#include <stdint.h>
#include <string.h>

// ── Protocol versioning ──────────────────────────────────────────────────────
// HELLO carries the version this device speaks. Backward-compat lives in the
// server (easy to update), not the firmware (flashed onto devices), so the device
// only ever announces CURRENT. MIN_SUPPORTED is informational here — the server
// enforces it and surfaces an "update firmware" notice below it.
// Bumped 1 → 2 for USB provisioning: a v2 HELLO tells the app this firmware understands
// SET_WIFI/SET_TRANSPORT (the app only sends those to version ≥ 2 devices).
#define PROTOCOL_VERSION_CURRENT 2
#define PROTOCOL_VERSION_MIN_SUPPORTED 1

// ── Network ports ────────────────────────────────────────────────────────────
#define SERVER_PORT 7000     // default TCP port; the real one comes from discovery
#define DISCOVERY_PORT 7001  // UDP broadcast discovery, both directions

// ── Message types (the first payload byte) ───────────────────────────────────
// Device→server and server→device type spaces are independent; both start at 0x01.
// HELLO/HEARTBEAT/SET_COLOR travel over both transports; the rest are USB-only
// provisioning/diagnostics frames.
#define MSG_HELLO 0x01      // device → server (both transports)
#define MSG_HEARTBEAT 0x02  // device → server (TCP; unused over USB — port close is liveness)
#define MSG_STATUS 0x03     // device → host  (USB): transport/WiFi status snapshot
#define MSG_LOG 0x04        // device → host  (USB): framed log line (release builds)
#define MSG_SCAN_RESULT 0x05  // device → host (USB): reserved, deferred post-v1.2

#define MSG_SET_COLOR 0x01     // server → device (both transports)
// 0x02 retired (was IDENTIFY): flashing is now driven server-side over SET_COLOR.
#define MSG_SET_WIFI 0x03      // host → device  (USB): persist creds + validating join
#define MSG_SET_TRANSPORT 0x04  // host → device (USB): persist transport mode
#define MSG_GET_STATUS 0x05    // host → device  (USB): request a STATUS frame
#define MSG_SCAN_WIFI 0x06     // host → device  (USB): reserved, deferred post-v1.2
#define MSG_RELAY 0x07         // host → device  (USB): reserved for v1.3 ESP-NOW bridge, unimplemented

// ── Shared payload field enums ───────────────────────────────────────────────
// Transport is an OPEN enum: stored as an int (NVS), a wire byte, and the IPC type —
// never a bool — so v1.3 can add ESP-NOW (2) without a migration.
#define TRANSPORT_NOTX 0
#define TRANSPORT_WIFI 1
// WiFi join progress, streamed in STATUS so the wizard confirms a join before unplug.
#define WIFI_STATE_IDLE 0
#define WIFI_STATE_JOINING 1
#define WIFI_STATE_CONNECTED 2
#define WIFI_STATE_FAILED 3
// LOG severity.
#define LOG_LEVEL_INFO 0
#define LOG_LEVEL_WARN 1
#define LOG_LEVEL_ERROR 2

// ── Standard colours (ARCHITECTURE.md "Standard Colours"), R, G, B ───────────
// These are what the *server* drives via SET_COLOR; the firmware renders whatever
// it's told. The two device-owned signals (DISCONNECTED, SETUP) are the only
// colours the firmware chooses on its own — see main.cpp's LED state machine.
#define COLOR_LIVE 255, 0, 0          // input is on Program output
#define COLOR_PREVIEW 0, 255, 0       // input is on Preview
#define COLOR_IDLE 30, 30, 30         // not selected, source trustworthy (dim white)
// Device-local steady blue. As of the LED.md palette its *local* meaning narrows to a single
// case: "WiFi is fine but we lost the TallyBot server" (LED.md state 10 — go check the PC).
// The other bring-up phases now use their own indicator colours (amber/cyan/white) defined in
// main.cpp, so blue no longer doubles for "connecting / discovering / WiFi-down".
#define COLOR_DISCONNECTED 0, 0, 255
#define COLOR_SETUP 255, 0, 255       // magenta: shown locally while provisioning (captive portal)

#define DEFAULT_BRIGHTNESS 128  // server's default; configurable per device in the UI
// Device-owned indicator drive level. A *raw* level, not a perceptual byte: only the server's
// SET_COLOR brightness is gamma-corrected (main.cpp); these indicators aren't. ~10% of full so
// the bring-up colours (and the boot self-test) don't blind the operator at close range.
#define LOCAL_BRIGHTNESS 26

// ── Discovery (UDP, text datagrams) ──────────────────────────────────────────
#define DISCOVERY_REQUEST "TALLY_FIND"            // device → broadcast
#define DISCOVERY_RESPONSE_PREFIX "TALLY_HERE:"   // server → "TALLY_HERE:<tcpPort>"

// ── Timers ───────────────────────────────────────────────────────────────────
#define HEARTBEAT_INTERVAL_MS 10000  // device heartbeats every 10s (ARCHITECTURE.md)
#define DISCOVERY_INTERVAL_MS 2000   // re-broadcast TALLY_FIND every 2s until found
// Server-side, for reference only (the firmware doesn't enforce these):
//   HEARTBEAT_TIMEOUT_MS 30000 — server drops a device silent this long
//   ANNOUNCE_INTERVAL_MS  5000 — server broadcasts its presence this often

// ── Framing ──────────────────────────────────────────────────────────────────
#define MAX_PAYLOAD_BYTES 255  // largest payload a single length byte can frame

// A decoded server → device message. SET_COLOR arrives over both transports;
// SET_WIFI/SET_TRANSPORT/GET_STATUS are USB-only provisioning frames.
struct ServerMessage {
  enum Kind { SET_COLOR, SET_WIFI, SET_TRANSPORT, GET_STATUS, UNKNOWN } kind;
  uint8_t r, g, b, brightness;  // valid only when kind == SET_COLOR
  char ssid[33];                // valid only when kind == SET_WIFI (≤32 chars + NUL)
  char pass[64];                // valid only when kind == SET_WIFI (≤63 chars + NUL)
  uint8_t transportMode;        // valid only when kind == SET_TRANSPORT
};

// Reassembles length-prefixed frames from a TCP byte stream. TCP has no message
// boundaries, so reads may split a frame or coalesce several; feed every chunk
// through `push` and act on the complete payloads via the callback. This mirrors
// the TypeScript `FrameDecoder.push`, but over a fixed buffer (no heap on the MCU)
// — an oversized or malformed length resets the buffer rather than indexing out of
// bounds, the hardening the dynamic TS array gets for free.
class FrameDecoder {
 public:
  // Largest inbound frame is SET_COLOR (6 bytes on the wire). 64 leaves generous
  // slack for several coalesced commands in one read while staying tiny.
  static const size_t CAPACITY = 64;

  // Drop any buffered partial frame. Call on every new TCP connection.
  void reset() { len_ = 0; }

  // Feed a chunk; `onPayload(payload, payloadLen)` fires once per complete frame,
  // with the length byte stripped (payload starts at its type byte).
  template <typename OnPayload>
  void push(const uint8_t* data, size_t n, OnPayload onPayload) {
    for (size_t i = 0; i < n; i++) {
      if (len_ >= CAPACITY) {
        // Buffer full without a complete frame: a corrupt/oversized length byte is
        // stalling us. Drop everything and resync on the next bytes.
        len_ = 0;
      }
      buf_[len_++] = data[i];

      // Drain every complete frame currently buffered.
      size_t offset = 0;
      while (offset < len_) {
        uint8_t frameLen = buf_[offset];
        if (offset + 1 + frameLen > len_) break;  // frame not fully arrived yet
        onPayload(&buf_[offset + 1], frameLen);
        offset += 1 + frameLen;
      }
      // Shift any unconsumed tail down to the front.
      if (offset > 0) {
        memmove(buf_, buf_ + offset, len_ - offset);
        len_ -= offset;
      }
    }
  }

 private:
  uint8_t buf_[CAPACITY];
  size_t len_ = 0;
};

// ── Device → server encoders ─────────────────────────────────────────────────

// ── Shared payload builders (the unframed [type][fields…] body) ──────────────
// These build only the payload — the unit shared across transports. TCP callers
// prepend a length byte (the encode* helpers below); the USB path hands the same
// payload to PacketSerial, which applies the COBS wrapper. Identity is the STA MAC
// (WiFi.macAddress()): v1.3 ESP-NOW addresses peers by this exact MAC, so it must
// not change to e.g. the SoftAP MAC.

// HELLO payload: [type][version][MAC×6] — 8 bytes. `out` must hold ≥ 8.
inline size_t encodeHelloPayload(uint8_t* out, const uint8_t mac[6]) {
  out[0] = MSG_HELLO;
  out[1] = PROTOCOL_VERSION_CURRENT;
  memcpy(&out[2], mac, 6);
  return 8;
}

// STATUS payload: [type][transport][wifiState][rssi][ssidLen][ssid…]. The SSID (the device's
// stored network, read from NVS) replaces the old credsPresent bool — the host derives
// "has creds" from ssidLen > 0, and keeps the name accurate even for a device it never
// provisioned. `ssidLen` is capped at 32 (802.11 max); `out` must hold ≥ 5 + min(ssidLen, 32).
inline size_t encodeStatusPayload(uint8_t* out, uint8_t transport, uint8_t wifiState, int8_t rssi,
                                  const char* ssid, uint8_t ssidLen) {
  if (ssidLen > 32) ssidLen = 32;  // clamp; SSIDs are ≤ 32 bytes
  out[0] = MSG_STATUS;
  out[1] = transport;
  out[2] = wifiState;
  out[3] = (uint8_t)rssi;  // signed byte on the wire; host sign-extends
  out[4] = ssidLen;
  for (uint8_t i = 0; i < ssidLen; i++) out[5 + i] = (uint8_t)ssid[i];
  return 5 + ssidLen;
}

// LOG payload: [type][level][utf8…]. Copies up to `maxOut-2` message bytes. Returns the
// payload length written. `out` must hold ≥ 2 bytes.
inline size_t encodeLogPayload(uint8_t* out, size_t maxOut, uint8_t level, const char* msg,
                               size_t msgLen) {
  out[0] = MSG_LOG;
  out[1] = level;
  size_t room = maxOut >= 2 ? maxOut - 2 : 0;
  if (msgLen > room) msgLen = room;
  memcpy(&out[2], msg, msgLen);
  return 2 + msgLen;
}

// ── Device → server encoders (TCP frames: payload + leading length byte) ──────

// HELLO — sent immediately on every (re)connect: [len][type][version][MAC×6].
// `out` must hold at least 9 bytes; returns the frame length (9).
inline size_t encodeHello(uint8_t* out, const uint8_t mac[6]) {
  out[0] = 8;  // payload length: type + version + 6 MAC bytes
  encodeHelloPayload(&out[1], mac);
  return 9;
}

// HEARTBEAT — the periodic keep-alive. Carries no MAC; the socket is the identity.
// `out` must hold at least 2 bytes; returns the frame length (2).
inline size_t encodeHeartbeat(uint8_t* out) {
  out[0] = 1;  // payload length: just the type byte
  out[1] = MSG_HEARTBEAT;
  return 2;
}

// ── Server → device decoder ──────────────────────────────────────────────────

// Decode one unframed server→device payload (as produced by FrameDecoder). The
// first byte is the message type. Returns false (kind UNKNOWN) on an unknown type
// or a payload whose length doesn't match its type — the caller skips it and the
// framing resyncs on the next frame. Mirrors the TS `decodeServerMessage`.
inline bool decodeServerMessage(const uint8_t* payload, size_t len, ServerMessage* out) {
  if (len == 0) {
    out->kind = ServerMessage::UNKNOWN;
    return false;
  }
  switch (payload[0]) {
    case MSG_SET_COLOR:  // [type][R][G][B][brightness] — 5 payload bytes
      if (len != 5) break;
      out->kind = ServerMessage::SET_COLOR;
      out->r = payload[1];
      out->g = payload[2];
      out->b = payload[3];
      out->brightness = payload[4];
      return true;
    case MSG_SET_WIFI: {  // [type][ssidLen][ssid…][passLen][pass…] — USB only
      if (len < 3) break;  // need at least type + ssidLen + passLen
      uint8_t ssidLen = payload[1];
      if (ssidLen >= sizeof(out->ssid)) break;          // would overflow the field
      if ((size_t)(2 + ssidLen) >= len) break;          // passLen byte must be present
      uint8_t passLen = payload[2 + ssidLen];
      if (passLen >= sizeof(out->pass)) break;
      if ((size_t)(3 + ssidLen + passLen) != len) break;  // exact-length check
      memcpy(out->ssid, &payload[2], ssidLen);
      out->ssid[ssidLen] = '\0';
      memcpy(out->pass, &payload[3 + ssidLen], passLen);
      out->pass[passLen] = '\0';
      out->kind = ServerMessage::SET_WIFI;
      return true;
    }
    case MSG_SET_TRANSPORT:  // [type][mode] — 2 payload bytes
      if (len != 2) break;
      out->kind = ServerMessage::SET_TRANSPORT;
      out->transportMode = payload[1];
      return true;
    case MSG_GET_STATUS:  // [type] — 1 payload byte
      if (len != 1) break;
      out->kind = ServerMessage::GET_STATUS;
      return true;
  }
  out->kind = ServerMessage::UNKNOWN;
  return false;
}

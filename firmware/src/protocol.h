// TallyBot binary wire protocol — the device (firmware) side.
//
// This file is the C++ mirror of `app/sidecar/src/protocol.ts`. The sidecar is the
// source of truth (see `ARCHITECTURE.md` "Binary Message Protocol"); these values
// and the framing logic must stay in lockstep with it. If you change one, change the
// other — a maintainer editing the TS should find this header, and vice versa.
//
// Framing: every message is length-prefixed — a single leading byte gives the number
// of payload bytes that follow, and the first payload byte is the message type. One
// uniform loop frames any message regardless of length, which lets a parser skip a
// message (or trailing fields) it doesn't recognise.
//
//   [len][payload …]      len = count of payload bytes that follow (1 byte, 0–255)
//
// Wire reference (exact bytes):
//   HELLO      08 01 01 <mac0..mac5>      (device → server)
//   HEARTBEAT  01 02                      (device → server)
//   SET_COLOR  05 01 <R> <G> <B> <bri>    (server → device)
//   IDENTIFY   01 02                      (server → device)

#pragma once

#include <stdint.h>
#include <string.h>

// ── Protocol versioning ──────────────────────────────────────────────────────
// HELLO carries the version this device speaks. Backward-compat lives in the
// server (easy to update), not the firmware (flashed onto devices), so the device
// only ever announces CURRENT. MIN_SUPPORTED is informational here — the server
// enforces it and surfaces an "update firmware" notice below it.
#define PROTOCOL_VERSION_CURRENT 1
#define PROTOCOL_VERSION_MIN_SUPPORTED 1

// ── Network ports ────────────────────────────────────────────────────────────
#define SERVER_PORT 7000     // default TCP port; the real one comes from discovery
#define DISCOVERY_PORT 7001  // UDP broadcast discovery, both directions

// ── Message types (the first payload byte) ───────────────────────────────────
// Device→server and server→device type spaces are independent; both start at 0x01.
#define MSG_HELLO 0x01      // device → server
#define MSG_HEARTBEAT 0x02  // device → server
#define MSG_SET_COLOR 0x01  // server → device
#define MSG_IDENTIFY 0x02   // server → device

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

// A decoded server → device message.
struct ServerMessage {
  enum Kind { SET_COLOR, IDENTIFY, UNKNOWN } kind;
  uint8_t r, g, b, brightness;  // valid only when kind == SET_COLOR
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

// HELLO — sent immediately on every (re)connect: [type][version][MAC×6].
// `out` must hold at least 9 bytes; returns the frame length (9).
inline size_t encodeHello(uint8_t* out, const uint8_t mac[6]) {
  out[0] = 8;  // payload length: type + version + 6 MAC bytes
  out[1] = MSG_HELLO;
  out[2] = PROTOCOL_VERSION_CURRENT;
  memcpy(&out[3], mac, 6);
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
    case MSG_IDENTIFY:  // [type] — 1 payload byte
      if (len != 1) break;
      out->kind = ServerMessage::IDENTIFY;
      return true;
  }
  out->kind = ServerMessage::UNKNOWN;
  return false;
}

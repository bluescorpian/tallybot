//! USB-serial wire protocol — the **minimal** Rust mirror.
//!
//! The shell owns the serial port but is a near-dumb byte pipe: it does COBS
//! framing and parses **only HELLO** (to learn a device's MAC + version for
//! detection and outbound routing). Every other payload is forwarded opaque to the
//! sidecar, whose `app/sidecar/src/protocol.ts` stays the single payload-codec
//! authority. So this file mirrors just two things from `protocol.ts` /
//! `firmware/src/protocol.h`: COBS framing and the HELLO layout. Keep the three in
//! lockstep — a maintainer touching the protocol should find all three.
//!
//! Framing is COBS (Consistent Overhead Byte Stuffing): a lone `0x00` is the frame
//! delimiter and never appears inside an encoded frame, so after any corruption the
//! decoder resyncs on the next `0x00` — the self-synchronising property a plain
//! length prefix lacks. We hand-roll it (≈40 lines, no `0x00` in output) rather than
//! pull a crate: it's auditable, needs no system libs, and is trivially unit-tested.

/// HELLO message type (device → host), the only payload type the shell parses.
pub const MSG_HELLO: u8 = 0x01;
/// HELLO payload length: `[type][version][MAC×6]`.
const HELLO_LEN: usize = 8;

/// A parsed HELLO frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub version: u8,
    /// Lower-case colon MAC, e.g. `"aa:bb:cc:dd:ee:ff"` — matches the sidecar's identity form.
    pub mac: String,
}

/// Parse a HELLO payload (already COBS-decoded), or `None` if it isn't a well-formed HELLO.
pub fn parse_hello(payload: &[u8]) -> Option<Hello> {
    if payload.len() != HELLO_LEN || payload[0] != MSG_HELLO {
        return None;
    }
    let version = payload[1];
    let mac = payload[2..HELLO_LEN]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":");
    Some(Hello { version, mac })
}

// ── COBS ─────────────────────────────────────────────────────────────────────

/// COBS-encode `data` and append the `0x00` frame delimiter — a complete frame ready
/// to write to the port.
pub fn cobs_frame(data: &[u8]) -> Vec<u8> {
    let mut out = cobs_encode(data);
    out.push(0);
    out
}

/// COBS-encode `data` (no trailing delimiter). The output contains no `0x00` bytes.
pub fn cobs_encode(data: &[u8]) -> Vec<u8> {
    // Worst case adds one overhead byte per 254 data bytes, plus the leading code byte.
    let mut out = Vec::with_capacity(data.len() + data.len() / 254 + 2);
    let mut code_idx = 0usize; // index of the pending code byte
    out.push(0); // placeholder, filled in when the run ends
    let mut code: u8 = 1;
    for &b in data {
        if b != 0 {
            out.push(b);
            code += 1;
            if code == 0xFF {
                // Maximal run: close it and open a fresh block.
                out[code_idx] = code;
                code_idx = out.len();
                out.push(0);
                code = 1;
            }
        } else {
            // A zero ends the current run; the code byte encodes its length.
            out[code_idx] = code;
            code_idx = out.len();
            out.push(0);
            code = 1;
        }
    }
    out[code_idx] = code;
    out
}

/// Decode a single COBS frame's encoded bytes (delimiter already stripped). Returns
/// `None` on a malformed frame (an embedded `0x00`, or a code byte that overruns) —
/// the caller drops it and resyncs on the next delimiter.
pub fn cobs_decode(enc: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(enc.len());
    let mut i = 0usize;
    while i < enc.len() {
        let code = enc[i] as usize;
        if code == 0 {
            return None; // a 0x00 can't appear inside an encoded frame
        }
        i += 1;
        if i + (code - 1) > enc.len() {
            return None; // the run overruns the frame
        }
        for _ in 1..code {
            out.push(enc[i]);
            i += 1;
        }
        // A non-maximal block that isn't the last one stood in for a literal zero.
        if code < 0xFF && i < enc.len() {
            out.push(0);
        }
    }
    Some(out)
}

/// Accumulates raw serial bytes and emits a decoded payload per `0x00`-delimited COBS
/// frame. A frame that fails to decode is dropped; the next `0x00` resyncs the stream,
/// so an injected garbage/panic-text run loses at most the corrupted frame.
#[derive(Default)]
pub struct CobsStream {
    buf: Vec<u8>,
}

impl CobsStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed received bytes; `on_frame` fires once per complete, well-formed frame.
    pub fn push(&mut self, data: &[u8], mut on_frame: impl FnMut(Vec<u8>)) {
        for &b in data {
            if b == 0 {
                if !self.buf.is_empty() {
                    if let Some(decoded) = cobs_decode(&self.buf) {
                        on_frame(decoded);
                    }
                    self.buf.clear();
                }
                // A lone delimiter (empty buffer) is just inter-frame padding — ignore.
            } else {
                self.buf.push(b);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(data: &[u8]) {
        let frame = cobs_frame(data);
        assert_eq!(*frame.last().unwrap(), 0, "frame ends with the delimiter");
        assert!(
            !frame[..frame.len() - 1].contains(&0),
            "no 0x00 inside the encoded body"
        );
        let decoded = cobs_decode(&frame[..frame.len() - 1]).expect("decodes");
        assert_eq!(decoded, data);
    }

    #[test]
    fn roundtrips_various_payloads() {
        roundtrip(&[]);
        roundtrip(&[1, 2, 3]);
        roundtrip(&[0]); // a single zero
        roundtrip(&[0, 0, 0]);
        roundtrip(&[1, 0, 2, 0, 3]);
        roundtrip(&(0..=255u8).collect::<Vec<_>>()); // includes zeros + a >254 run
        roundtrip(&vec![7u8; 600]); // forces a maximal-run block split
    }

    #[test]
    fn stream_splits_frames_on_the_delimiter() {
        let a = cobs_frame(&[0x01, 0x02, 0x03]);
        let b = cobs_frame(&[0x00, 0xff]);
        let mut wire = a.clone();
        wire.extend_from_slice(&b);

        let mut frames = Vec::new();
        let mut s = CobsStream::new();
        s.push(&wire, |f| frames.push(f));
        assert_eq!(frames, vec![vec![0x01, 0x02, 0x03], vec![0x00, 0xff]]);
    }

    #[test]
    fn stream_reassembles_a_frame_split_byte_by_byte() {
        let frame = cobs_frame(&[0xaa, 0x00, 0xbb]);
        let mut frames = Vec::new();
        let mut s = CobsStream::new();
        for byte in frame {
            s.push(&[byte], |f| frames.push(f));
        }
        assert_eq!(frames, vec![vec![0xaa, 0x00, 0xbb]]);
    }

    #[test]
    fn stream_resyncs_past_injected_garbage_and_panic_text() {
        // A real device might emit a ROM panic backtrace (raw text) between frames.
        let mut wire = Vec::new();
        wire.extend_from_slice(b"Guru Meditation Error: Core panic'd\r\n"); // raw text, no 0x00
        wire.push(0); // a stray delimiter closes the garbage run
        wire.extend_from_slice(&cobs_frame(&[0x03, 0x01, 0x01])); // a clean STATUS-shaped frame

        let mut frames = Vec::new();
        let mut s = CobsStream::new();
        s.push(&wire, |f| frames.push(f));
        // The text run fails to decode (or decodes to junk) and is dropped; the next
        // delimiter resyncs and the clean frame survives.
        assert_eq!(*frames.last().unwrap(), vec![0x03, 0x01, 0x01]);
    }

    #[test]
    fn parses_a_hello_frame() {
        let payload = [MSG_HELLO, 2, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
        let frame = cobs_frame(&payload);
        let mut got = None;
        let mut s = CobsStream::new();
        s.push(&frame, |f| got = parse_hello(&f));
        assert_eq!(
            got,
            Some(Hello {
                version: 2,
                mac: "aa:bb:cc:dd:ee:ff".to_string()
            })
        );
    }

    #[test]
    fn rejects_non_hello_payloads() {
        assert_eq!(parse_hello(&[]), None);
        assert_eq!(parse_hello(&[MSG_HELLO, 2, 0, 0, 0]), None); // too short
        assert_eq!(parse_hello(&[0x03, 2, 0, 0, 0, 0, 0, 0]), None); // wrong type (STATUS)
    }
}

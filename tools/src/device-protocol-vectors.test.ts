// The protocol mirror guard, simulator side: the simulated device's encoders and its SET_COLOR
// decoder against the shared `app/sidecar/src/protocol-vectors.json` (see its header).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decodeServerMessage, encodeFirmware, encodeHeartbeat, encodeHello } from "./device-protocol.ts";

interface Vector {
  name: string;
  payload: string;
  decoded: Record<string, unknown> | null;
  deviceEncodes?: boolean;
}
const vectors = JSON.parse(
  readFileSync(new URL("../../app/sidecar/src/protocol-vectors.json", import.meta.url), "utf8"),
) as { deviceToServer: Vector[]; serverToDevice: Vector[] };

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
/** A TCP frame's payload: the frame minus its length byte, which must count the rest. */
const payloadOf = (frame: Uint8Array): Uint8Array => {
  assert.equal(frame[0], frame.length - 1, "length byte");
  return frame.subarray(1);
};

/** The simulator's encoder for a device→server message it sends, or null for one it doesn't. */
function encode(d: Record<string, unknown>): Uint8Array | null {
  switch (d["kind"]) {
    case "hello":
      return payloadOf(encodeHello(d["mac"] as string, d["version"] as number));
    case "heartbeat":
      return payloadOf(encodeHeartbeat());
    case "firmware":
      return payloadOf(encodeFirmware(d["version"] as string));
    default:
      return null;
  }
}

for (const v of vectors.deviceToServer) {
  const encoded = v.decoded === null ? null : encode(v.decoded);
  if (encoded === null) continue;
  test(`the simulated device encodes "${v.name}" as the vectors say`, () => {
    assert.equal(hex(encoded), v.payload);
  });
}

// The simulator decodes SET_COLOR only; every other server→device type is one it refuses.
for (const v of vectors.serverToDevice) {
  test(`the simulated device decodes "${v.name}" as the vectors say`, () => {
    const payload = Uint8Array.from(Buffer.from(v.payload, "hex"));
    if (v.decoded?.["kind"] !== "SET_COLOR") {
      assert.throws(() => decodeServerMessage(payload), RangeError);
      return;
    }
    const { r, g, b, brightness } = v.decoded as { r: number; g: number; b: number; brightness: number };
    assert.deepEqual(decodeServerMessage(payload), { kind: "setColor", color: { r, g, b }, brightness });
  });
}

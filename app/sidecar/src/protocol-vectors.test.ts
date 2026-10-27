// The protocol mirror guard, sidecar side: protocol.ts against the shared `protocol-vectors.json`
// (see its header for the other consumers). A constant or a decoder that drifts from the file
// fails here; the same file fails the firmware, shell or simulator if one of those drifts instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COLORS,
  DEFAULT_BRIGHTNESS,
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_PORT,
  DISCOVERY_REQUEST,
  DISCOVERY_RESPONSE_PREFIX,
  DeviceMessageType,
  ESPNOW_CHANNEL,
  ESPNOW_CHANNELS,
  HEARTBEAT_INTERVAL_MS,
  HOST_SILENCE_TIMEOUT_MS,
  LogLevel,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  SERVER_PORT,
  ServerMessageType,
  Transport,
  WIFI_PASSWORD_MAX_BYTES,
  WIFI_SSID_MAX_BYTES,
  WifiState,
  decodeDeviceMessage,
  getStatusPayload,
  relayPayload,
  setBridgePayload,
  setColorPayload,
  setTransportPayload,
  setWifiPayload,
} from "./protocol.ts";

interface Vector {
  name: string;
  payload: string;
  decoded: Record<string, unknown> | null;
}
const vectors = JSON.parse(readFileSync(new URL("./protocol-vectors.json", import.meta.url), "utf8")) as {
  constants: Record<string, unknown>;
  deviceToServer: Vector[];
  serverToDevice: Vector[];
};

const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

test("protocol.ts's constants match the shared vectors", () => {
  const colors = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, [c.r, c.g, c.b]]));
  assert.deepEqual(
    {
      PROTOCOL_VERSION_CURRENT: PROTOCOL_VERSION.CURRENT,
      PROTOCOL_VERSION_MIN_SUPPORTED: PROTOCOL_VERSION.MIN_SUPPORTED,
      PROTOCOL_VERSION_ESPNOW: PROTOCOL_VERSION.ESPNOW,
      SERVER_PORT,
      DISCOVERY_PORT,
      DISCOVERY_REQUEST,
      DISCOVERY_RESPONSE_PREFIX,
      deviceMessageType: { ...DeviceMessageType },
      serverMessageType: { ...ServerMessageType },
      transport: { ...Transport },
      wifiState: { ...WifiState },
      logLevel: { ...LogLevel },
      colors,
      DEFAULT_BRIGHTNESS,
      MAX_PAYLOAD_BYTES,
      ESPNOW_CHANNEL,
      ESPNOW_CHANNEL_MIN: ESPNOW_CHANNELS.MIN,
      ESPNOW_CHANNEL_MAX: ESPNOW_CHANNELS.MAX,
      WIFI_SSID_MAX_BYTES,
      WIFI_PASSWORD_MAX_BYTES,
      HEARTBEAT_INTERVAL_MS,
      DISCOVERY_INTERVAL_MS,
      HOST_SILENCE_TIMEOUT_MS,
    },
    vectors.constants,
  );
});

for (const v of vectors.deviceToServer) {
  test(`device→server vector "${v.name}" decodes as the vectors say`, () => {
    if (v.decoded === null) {
      assert.throws(() => decodeDeviceMessage(bytes(v.payload)), RangeError);
      return;
    }
    const message = decodeDeviceMessage(bytes(v.payload));
    const got = message.kind === "relayed" ? { ...message, inner: hex(message.inner) } : message;
    assert.deepEqual(got, v.decoded);
  });
}

/** The sidecar's encoder for an accepted server→device vector's fields. */
function encode(d: Record<string, unknown>): Uint8Array {
  switch (d["kind"]) {
    case "SET_COLOR":
      return setColorPayload({ r: d["r"] as number, g: d["g"] as number, b: d["b"] as number }, d["brightness"] as number);
    case "SET_WIFI":
      return setWifiPayload(d["ssid"] as string, d["password"] as string);
    case "SET_TRANSPORT":
      return setTransportPayload(d["mode"] as number, (d["channel"] as number | null) ?? undefined);
    case "GET_STATUS":
      return getStatusPayload();
    case "SET_BRIDGE":
      return setBridgePayload(d["enabled"] as boolean, d["channel"] as number);
    case "RELAY":
      return relayPayload(d["targetMac"] as string, bytes(d["inner"] as string));
    default:
      throw new Error(`no encoder for ${String(d["kind"])}`);
  }
}

for (const v of vectors.serverToDevice) {
  if (v.decoded === null) continue; // the device's decoder is the one that must refuse these
  test(`server→device vector "${v.name}" is what the sidecar encodes`, () => {
    assert.equal(hex(encode(v.decoded!)), v.payload);
  });
}

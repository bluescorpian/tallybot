// The protocol mirror guard's firmware leg: compile firmware/src/protocol.h for the host and check
// it against the shared vectors (app/sidecar/src/protocol-vectors.json). The sidecar, the shell and
// the simulator check the same file from their own test suites.
//
//   node scripts/check-protocol-mirrors.mjs [c++ compiler]     (default: $CXX, else g++)
//
// It writes the vectors as `vectors.inc` (V_* constant macros, one check call per vector) into a
// temporary directory and builds firmware/test/host/protocol_vectors.cpp against it. Exits non-zero
// when the header and the vectors disagree.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(readFileSync(join(root, "app/sidecar/src/protocol-vectors.json"), "utf8"));
const cxx = process.argv[2] ?? process.env.CXX ?? "g++";

const str = (s) => JSON.stringify(s); // a JSON string literal is a valid C string literal for ASCII
const bytes = (hex) => `Bytes{${(hex.match(/../g) ?? []).map((b) => `0x${b}`).join(", ")}}`;
const macBytes = (mac) => bytes(mac.replaceAll(":", ""));

// ── Constants → V_* macros (nested keys joined with _; colours as a byte list) ─────────────────
const lines = [];
function define(name, value) {
  if (Array.isArray(value)) lines.push(`#define V_${name} ${value.join(", ")}`);
  else if (typeof value === "object") for (const [k, v] of Object.entries(value)) define(`${name}_${k}`, v);
  else lines.push(`#define V_${name} ${typeof value === "string" ? str(value) : value}`);
}
for (const [name, value] of Object.entries(vectors.constants)) define(name, value);

// ── Server → device: what decodeServerMessage must make of each payload ───────────────────────
const fieldChecks = {
  SET_COLOR: (d) => `m.r == ${d.r} && m.g == ${d.g} && m.b == ${d.b} && m.brightness == ${d.brightness}`,
  SET_WIFI: (d) => `strcmp(m.ssid, ${str(d.ssid)}) == 0 && strcmp(m.pass, ${str(d.password)}) == 0`,
  SET_TRANSPORT: (d) =>
    d.channel === null ? `m.transportMode == ${d.mode} && !m.hasChannel` : `m.transportMode == ${d.mode} && m.hasChannel && m.channel == ${d.channel}`,
  GET_STATUS: () => "true",
  SET_BRIDGE: (d) =>
    `m.bridgeEnabled == ${d.enabled} && m.channel == ${d.channel} && ` +
    (d.txPower === null ? "!m.hasTxPower && m.txPower == BRIDGE_TX_POWER_FULL" : `m.hasTxPower && m.txPower == ${d.txPower}`),
  SCAN_WIFI: () => "true",
  RELAY: (d) =>
    `memcmp(m.targetMac, ${macBytes(d.targetMac)}.data(), 6) == 0 && sameBytes(m.inner, m.innerLen, ${bytes(d.inner)})`,
};
const calls = [];
for (const v of vectors.serverToDevice) {
  const d = v.decoded;
  if (d && !fieldChecks[d.kind]) throw new Error(`no field check for ${d.kind}`);
  const kind = d ? `ServerMessage::${d.kind}` : "ServerMessage::UNKNOWN";
  const check = d ? fieldChecks[d.kind](d) : "true";
  calls.push(`  checkDecode(${str(v.name)}, ${bytes(v.payload)}, ${d !== null}, ${kind}, [](const ServerMessage& m) { (void)m; return ${check}; });`);
}

// ── Device → server: what the firmware's encoders must produce ────────────────────────────────
const encoders = {
  hello: (d) => {
    if (d.version !== vectors.constants.PROTOCOL_VERSION_CURRENT) throw new Error("the firmware only sends a CURRENT HELLO");
    return `return encodeHelloPayload(out, ${macBytes(d.mac)}.data());`;
  },
  // The firmware only builds HEARTBEAT as a TCP frame: strip its length byte.
  heartbeat: () => "uint8_t frame[2]; size_t n = encodeHeartbeat(frame); memcpy(out, frame + 1, n - 1); return n - 1;",
  firmware: (d) => `return encodeFirmwarePayload(out, 64, ${str(d.version)});`,
  status: (d) =>
    `return encodeStatusPayload(out, ${d.transport}, ${d.wifiState}, ${d.rssi}, ${str(d.ssid)}, ${Buffer.byteLength(d.ssid)}, ${d.channel}, ${d.bridge ? 1 : 0});`,
  scanResult: (d) =>
    d.ap === null
      ? "return encodeEmptyScanResultPayload(out);"
      : `return encodeScanResultPayload(out, ${d.index}, ${d.total}, ${d.ap.channel}, ${d.ap.rssi}, ${str(d.ap.ssid)}, ${Buffer.byteLength(d.ap.ssid)});`,
  log: (d) => `return encodeLogPayload(out, 64, ${d.level}, ${str(d.text)}, ${Buffer.byteLength(d.text)});`,
};
for (const v of vectors.deviceToServer) {
  if (!v.deviceEncodes) continue;
  const encode = encoders[v.decoded.kind];
  if (!encode) throw new Error(`no firmware encoder for ${v.decoded.kind}`);
  calls.push(`  checkEncode(${str(v.name)}, ${bytes(v.payload)}, [](uint8_t* out) -> size_t { ${encode(v.decoded)} });`);
}

const inc = `${lines.join("\n")}\n\nstatic int runVectors() {\n${calls.join("\n")}\n  return ${calls.length};\n}\n`;

const dir = mkdtempSync(join(tmpdir(), "tallybot-protocol-"));
try {
  writeFileSync(join(dir, "vectors.inc"), inc);
  const bin = join(dir, "protocol_vectors");
  execFileSync(
    cxx,
    ["-std=c++17", "-Wall", "-Werror", "-I", join(root, "firmware/src"), "-I", dir, join(root, "firmware/test/host/protocol_vectors.cpp"), "-o", bin],
    { stdio: "inherit" },
  );
  execFileSync(bin, { stdio: "inherit" });
} catch (err) {
  console.error(`::error::protocol.h doesn't match app/sidecar/src/protocol-vectors.json (${err.message})`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

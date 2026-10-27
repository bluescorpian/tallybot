// Reading a merged ESP32 firmware image (the single 0x0 file both flashers ship).
//
// The partition table sits at 0x8000: 32-byte entries `[0xAA 0x50][type][subtype][offset u32 LE]
// [size u32 LE][label 16][flags u32]`, ended by an MD5 entry or erased flash. NVS is type 0x01,
// subtype 0x02. `app/src-tauri/src/flash.rs` reads the same table to write around NVS.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TABLE = 0x8000;
const TABLE_LEN = 0xc00;
const ENTRY = 32;

/** The image's NVS partitions as `{ offset, size }` (numbers), in table order. */
export function nvsPartitions(image) {
  const out = [];
  for (let at = TABLE; at + ENTRY <= Math.min(image.length, TABLE + TABLE_LEN); at += ENTRY) {
    if (image[at] !== 0xaa || image[at + 1] !== 0x50) break;
    if (image[at + 2] === 0x01 && image[at + 3] === 0x02) {
      out.push({ offset: image.readUInt32LE(at + 4), size: image.readUInt32LE(at + 8) });
    }
  }
  return out;
}

/** The NVS layout every shipped light has (`firmware/nvs-layout.json`), as numbers. */
export function expectedNvs() {
  const { nvs } = JSON.parse(readFileSync(join(root, "firmware/nvs-layout.json"), "utf8"));
  return nvs.map(({ offset, size }) => ({ offset: Number(offset), size: Number(size) }));
}

/** Why an image's NVS differs from the shipped layout, or null when it matches. */
export function nvsLayoutProblem(image) {
  const hex = (list) => list.map(({ offset, size }) => `0x${offset.toString(16)}+0x${size.toString(16)}`).join(", ") || "none";
  const have = nvsPartitions(image);
  const want = expectedNvs();
  const same = have.length === want.length && have.every((p, i) => p.offset === want[i].offset && p.size === want[i].size);
  return same
    ? null
    : `the image keeps NVS at ${hex(have)}, but shipped lights keep it at ${hex(want)} (firmware/nvs-layout.json): ` +
        "the in-app flasher would orphan every light's settings";
}

/** The protocol version the firmware announces (`PROTOCOL_VERSION_CURRENT` in protocol.h). */
export function firmwareProtocolVersion() {
  const header = readFileSync(join(root, "firmware/src/protocol.h"), "utf8");
  const match = header.match(/^#define PROTOCOL_VERSION_CURRENT (\d+)/m);
  if (!match) throw new Error("firmware/src/protocol.h has no PROTOCOL_VERSION_CURRENT");
  return Number(match[1]);
}

/** The protocol version the app speaks (`PROTOCOL_VERSION.CURRENT` in protocol.ts). */
export function appProtocolVersion() {
  const source = readFileSync(join(root, "app/sidecar/src/protocol.ts"), "utf8");
  const match = source.match(/export const PROTOCOL_VERSION = \{[\s\S]*?CURRENT: (\d+),/);
  if (!match) throw new Error("app/sidecar/src/protocol.ts has no PROTOCOL_VERSION.CURRENT");
  return Number(match[1]);
}

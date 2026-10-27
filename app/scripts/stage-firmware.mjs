// Stage a merged firmware image for the app to bundle, with its manifest beside it.
//
//   node scripts/stage-firmware.mjs [image] [outDir]
//
// image   the merged 0x0 image (default: the release env's `pio run -t mergebin` output)
// outDir  where to write it (default: src-tauri/resources/firmware, which tauri.conf.json
//         bundles as the `firmware/` resource directory)
//
// Writes the image and its manifest under the release's fixed names (scripts/release-assets.mjs):
//   { "version": "<firmware/VERSION>", "sha256": "<hex>", "size": <bytes>,
//     "protocol": <PROTOCOL_VERSION_CURRENT>, "nvs": [{ "offset": <n>, "size": <n> }] }
// The shell reads the manifest to tell the UI which firmware this build installs, and checks
// the image against its sha256 before flashing. `protocol` and `nvs` record what the image is.
//
// It refuses to stage an image that would hurt lights already in the field: one whose NVS isn't
// where shipped lights keep their settings (firmware/nvs-layout.json; the in-app flasher writes
// around it), or one that speaks a different protocol version than this app. The release workflow runs this in its firmware
// job; locally, `pnpm firmware:stage` builds the image first. A build without a staged image
// still runs: the flasher reports that this build carries no firmware.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appProtocolVersion, firmwareProtocolVersion, nvsLayoutProblem, nvsPartitions } from "../../scripts/firmware-image.mjs";
import { FIRMWARE } from "../../scripts/release-assets.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const firmware = resolve(app, "../firmware");
const image = resolve(process.argv[2] ?? join(firmware, ".pio/build/esp32-c3-release/tallybot-merged.bin"));
const outDir = resolve(process.argv[3] ?? join(app, "src-tauri/resources/firmware"));

const bytes = readFileSync(image);
const version = readFileSync(join(firmware, "VERSION"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`firmware/VERSION isn't x.y.z: "${version}"`);
const layout = nvsLayoutProblem(bytes);
if (layout) throw new Error(`refusing to stage ${image}: ${layout}`);
const protocol = firmwareProtocolVersion();
if (protocol !== appProtocolVersion()) {
  throw new Error(`firmware speaks protocol ${protocol}, the app ${appProtocolVersion()}: protocol.h and protocol.ts disagree`);
}
const manifest = {
  version,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  protocol,
  nvs: nvsPartitions(bytes),
};

mkdirSync(outDir, { recursive: true });
copyFileSync(image, join(outDir, FIRMWARE.image));
writeFileSync(join(outDir, FIRMWARE.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`staged firmware ${version} (${bytes.length} bytes) in ${outDir}`);

// Stage a merged firmware image for the app to bundle, with its manifest beside it.
//
//   node scripts/stage-firmware.mjs [image] [outDir]
//
// image   the merged 0x0 image (default: the release env's `pio run -t mergebin` output)
// outDir  where to write it (default: src-tauri/resources/firmware, which tauri.conf.json
//         bundles as the `firmware/` resource directory)
//
// Writes tallybot-firmware-esp32c3.bin plus tallybot-firmware-esp32c3.json:
//   { "version": "<firmware/VERSION>", "sha256": "<hex>", "size": <bytes> }
// The shell reads the manifest to tell the UI which firmware this build installs, and checks
// the image against its sha256 before flashing. The release workflow runs this in its firmware
// job; locally, `pnpm firmware:stage` builds the image first. A build without a staged image
// still runs: the flasher reports that this build carries no firmware.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const firmware = resolve(app, "../firmware");
const image = resolve(process.argv[2] ?? join(firmware, ".pio/build/esp32-c3-release/tallybot-merged.bin"));
const outDir = resolve(process.argv[3] ?? join(app, "src-tauri/resources/firmware"));

const bytes = readFileSync(image);
const version = readFileSync(join(firmware, "VERSION"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`firmware/VERSION isn't x.y.z: "${version}"`);
const manifest = { version, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };

mkdirSync(outDir, { recursive: true });
copyFileSync(image, join(outDir, "tallybot-firmware-esp32c3.bin"));
writeFileSync(join(outDir, "tallybot-firmware-esp32c3.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`staged firmware ${version} (${bytes.length} bytes) in ${outDir}`);

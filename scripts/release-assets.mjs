// The names of everything a release publishes, and the update manifest built from them.
//
// One source for a string contract that spans the workflows and the app: release.yml names the
// installers it collects with it, update-manifest.yml builds latest.json with it, pages.yml and
// app/scripts/stage-firmware.mjs name the firmware with it, and scripts/check-release.mjs asserts
// the Rust shell's copies (firmware names in flash.rs, platform keys in updater.rs) still match.
// The names are what shipped releases already use: installed apps fetch latest.json by name and
// follow its URLs, so renaming an asset here breaks nothing only from the release that renames it.
//
//   node scripts/release-assets.mjs name <asset> [version]        print one asset's file name
//   node scripts/release-assets.mjs check-dist <version> <dir>    every asset (+ .sig) is in dir
//   node scripts/release-assets.mjs manifest <version> <dir> <base-url> [release.json]
//                                                                 print latest.json
//
// `manifest` reads the .sig files and the firmware manifest from <dir>; release.json is
// `gh release view --json body,publishedAt` (omitted in a dry run: no notes, no date).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The firmware image and its manifest: fixed names, so the shell and the web flasher find them. */
export const FIRMWARE = {
  image: "tallybot-firmware-esp32c3.bin",
  manifest: "tallybot-firmware-esp32c3.json",
};

/**
 * The app's assets for one version. `platform` is the latest.json key of an installer that
 * updates in place; those carry an updater signature (`<file>.sig`). There is deliberately no
 * bare `windows-x86_64` key, which a portable exe would otherwise match and "update" by running
 * the installer.
 */
export function appAssets(version) {
  return {
    nsis: { file: `TallyBot-${version}-windows-x64-setup.exe`, platform: "windows-x86_64-nsis" },
    msi: { file: `TallyBot-${version}-windows-x64.msi`, platform: "windows-x86_64-msi" },
    portable: { file: `TallyBot-${version}-windows-x64-portable.zip` },
    appimage: { file: `TallyBot-${version}-linux-x86_64.AppImage`, platform: "linux-x86_64-appimage" },
    deb: { file: `TallyBot-${version}-linux-amd64.deb` },
    rpm: { file: `TallyBot-${version}-linux-x86_64.rpm` },
  };
}

/** Every file a release for `version` attaches, before latest.json. */
export function releaseFiles(version) {
  const files = [FIRMWARE.image, FIRMWARE.manifest];
  for (const asset of Object.values(appAssets(version))) {
    files.push(asset.file);
    if (asset.platform) files.push(`${asset.file}.sig`);
  }
  return files;
}

/** latest.json for `version`, from the signatures and firmware manifest in `dir`. */
export function updateManifest(version, dir, baseUrl, release = {}) {
  const firmware = JSON.parse(readFileSync(join(dir, FIRMWARE.manifest), "utf8"));
  const platforms = {};
  for (const asset of Object.values(appAssets(version))) {
    if (!asset.platform) continue;
    platforms[asset.platform] = {
      url: `${baseUrl}/${asset.file}`,
      signature: readFileSync(join(dir, `${asset.file}.sig`), "utf8").trimEnd(),
    };
  }
  return {
    version,
    notes: release.body ?? null,
    pub_date: release.publishedAt ?? null,
    // A custom field: the in-app flasher uses it to say a newer app has newer light firmware.
    firmwareVersion: firmware.version,
    platforms,
  };
}

function assetName(key, version) {
  if (key === "firmware-image") return FIRMWARE.image;
  if (key === "firmware-manifest") return FIRMWARE.manifest;
  if (!version) throw new Error(`asset "${key}" needs a version`);
  const asset = appAssets(version)[key];
  if (!asset) throw new Error(`unknown asset "${key}"`);
  return asset.file;
}

function main([command, ...args]) {
  const usage = () => {
    throw new Error("usage: release-assets.mjs name|check-dist|manifest … (see the header)");
  };
  if (command === "name") {
    const [key, version] = args;
    if (!key) usage();
    console.log(assetName(key, version));
  } else if (command === "check-dist") {
    const [version, dir] = args;
    if (!version || !dir) usage();
    const missing = releaseFiles(version).filter((f) => !existsSync(join(dir, f)));
    if (missing.length) throw new Error(`missing from ${dir}: ${missing.join(", ")}`);
    console.log(`all ${releaseFiles(version).length} release assets for ${version} are in ${dir}`);
  } else if (command === "manifest") {
    const [version, dir, baseUrl, releaseJson] = args;
    if (!version || !dir || !baseUrl) usage();
    const release = releaseJson ? JSON.parse(readFileSync(releaseJson, "utf8")) : {};
    console.log(JSON.stringify(updateManifest(version, dir, baseUrl, release), null, 2));
  } else {
    usage();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`release-assets: ${err.message}`);
    process.exit(1);
  }
}

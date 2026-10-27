// Release consistency checks, runnable locally before tagging.
//
//   node scripts/check-release.mjs                 versions + asset-name mirrors (every PR, ci.yml)
//   node scripts/check-release.mjs --tag vX.Y.Z    also: the tag matches, and a firmware change
//                                                  since the last tag bumped firmware/VERSION
//
// The app's version lives in app/package.json (tauri.conf.json reads it from there) plus the
// places that can't read it: app/sidecar/package.json and Cargo.toml (+ Cargo.lock). The lights'
// only signal that they need new firmware is firmware/VERSION: the in-app flasher compares it to
// what each light reports, so a firmware change shipped without a bump is never offered to
// anyone. That check runs at release time only (comparing against the previous tag), so a PR can
// change firmware without bumping on every commit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appAssets, FIRMWARE } from "./release-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const errors = [];
const fail = (message) => errors.push(message);
const notes = [];

// ── App version ──────────────────────────────────────────────────────────────

const version = json("app/package.json").version;
const tauriVersion = json("app/src-tauri/tauri.conf.json").version;
if (tauriVersion !== "../package.json" && tauriVersion !== version) {
  fail(`tauri.conf.json version ${tauriVersion} != app/package.json ${version}`);
}
const sidecar = json("app/sidecar/package.json").version;
if (sidecar !== version) fail(`app/sidecar/package.json version ${sidecar} != app/package.json ${version}`);
const cargo = read("app/src-tauri/Cargo.toml").match(/^version = "(.*)"/m)?.[1];
if (cargo !== version) fail(`Cargo.toml version ${cargo} != app/package.json ${version}`);
const lock = read("app/src-tauri/Cargo.lock").match(/\[\[package\]\]\nname = "tallybot"\nversion = "(.*)"/)?.[1];
if (lock !== version) fail(`Cargo.lock's tallybot ${lock} != app/package.json ${version} (run cargo check)`);

// ── The shell's copies of the asset names ────────────────────────────────────

// flash.rs finds the bundled firmware by name; updater.rs names two latest.json platform keys as
// the check target for builds that can't update in place.
const flash = read("app/src-tauri/src/flash.rs");
for (const name of [FIRMWARE.image, FIRMWARE.manifest]) {
  if (!flash.includes(`"firmware/${name}"`)) fail(`flash.rs doesn't name the bundled firmware "${name}"`);
}
const updater = read("app/src-tauri/src/updater.rs");
const platforms = new Set(Object.values(appAssets(version)).flatMap((a) => (a.platform ? [a.platform] : [])));
for (const [, key] of updater.matchAll(/"((?:windows|linux|darwin)-[a-z0-9_]+-[a-z]+)"/g)) {
  if (!platforms.has(key)) fail(`updater.rs names platform "${key}", which latest.json doesn't carry`);
}

// ── Release-time checks ──────────────────────────────────────────────────────

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex === -1 ? null : process.argv[tagIndex + 1];
if (tagIndex !== -1 && !tag) fail("--tag needs a value");

const firmwareVersion = read("firmware/VERSION").trim();
if (!/^\d+\.\d+\.\d+$/.test(firmwareVersion)) fail(`firmware/VERSION isn't x.y.z: "${firmwareVersion}"`);

if (tag) {
  if (tag !== `v${version}`) fail(`tag ${tag} doesn't match app version ${version}`);

  // The previous release: the newest v* tag that isn't this one, reachable from HEAD.
  let previous = null;
  try {
    previous = git("describe", "--tags", "--abbrev=0", "--match", "v*", `${tag}^`);
  } catch {
    notes.push("no earlier v* tag: firmware/VERSION not compared");
  }
  if (previous) {
    // What ends up in the image: everything under firmware/ but its docs, the unused test dir and
    // legacy/ (the retired firmware, never built).
    const changed = git("diff", "--name-only", previous, tag, "--", "firmware")
      .split("\n")
      .filter((f) => f && !/(^|\/)README(\.md)?$/.test(f) && !f.startsWith("firmware/test/") && !f.startsWith("firmware/legacy/") && f !== "firmware/.gitignore");
    let previousVersion = null;
    try {
      previousVersion = git("show", `${previous}:firmware/VERSION`);
    } catch {
      notes.push(`${previous} has no firmware/VERSION: not compared`);
    }
    const bumped = previousVersion !== null && previousVersion !== firmwareVersion;
    const sourceChanged = changed.some((f) => f !== "firmware/VERSION");
    if (previousVersion !== null && sourceChanged && !bumped) {
      fail(
        `firmware changed since ${previous} but firmware/VERSION is still ${firmwareVersion}; lights would ` +
          `never be offered the new image. Bump it. Changed: ${changed.join(", ")}`,
      );
    }
    if (bumped && !sourceChanged) {
      notes.push(`firmware/VERSION bumped (${previousVersion} → ${firmwareVersion}) with no firmware change since ${previous}`);
    }
  }
}

for (const note of notes) console.log(`note: ${note}`);
if (errors.length) {
  for (const error of errors) console.error(`::error::${error}`);
  process.exit(1);
}
console.log(`release checks pass: app ${version}, firmware ${firmwareVersion}${tag ? `, tag ${tag}` : ""}`);

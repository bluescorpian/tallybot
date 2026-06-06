#!/usr/bin/env node
/**
 * Build the production sidecar as a single self-contained binary for Tauri's
 * `externalBin`. Two steps:
 *
 *   1. esbuild bundles `src/main.ts` (our code only) into one CommonJS file,
 *      leaving `atem-connection` external — so its `threadedClass` /
 *      `atemSocketChild` worker stays a real on-disk module. Bundling it is what
 *      historically broke pkg: the worker is loaded by *runtime path* (stack-trace
 *      introspection + `require.resolve` → `new Worker(path)`), not a static
 *      `require()` esbuild can see, so inlining it leaves the path dangling.
 *   2. `@yao-pkg/pkg` packs that bundle + the Node runtime into one executable,
 *      tracing the still-on-disk `atem-connection` (worker included) into its
 *      `/snapshot/` virtual FS. The output is named for the Rust target triple,
 *      which is what Tauri's externalBin resolver expects.
 *
 * Output: ../src-tauri/binaries/tallybot-sidecar-<triple>[.exe]
 *
 * Usage:
 *   node build.mjs                                   # build for the host triple
 *   node build.mjs --target x86_64-pc-windows-msvc   # cross-name + cross pkg target
 *
 * See ARCHITECTURE.md "Packaging the sidecar".
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import { exec as pkgExec } from "@yao-pkg/pkg";

const here = dirname(fileURLToPath(import.meta.url));

// The pkg base-runtime version. pkg fetches a prebuilt node of this major for the
// target; keep it on an LTS the project tests against.
const NODE_RANGE = "node22";

// Rust target triple → [pkg "<platform>-<arch>", executable suffix]. Tauri names
// externalBin files `<name>-<triple>` (with `.exe` on Windows); pkg names its
// runtime targets differently, hence the map.
const PKG_TARGET = {
  "x86_64-unknown-linux-gnu": ["linux-x64", ""],
  "aarch64-unknown-linux-gnu": ["linux-arm64", ""],
  "x86_64-pc-windows-msvc": ["win-x64", ".exe"],
  "aarch64-pc-windows-msvc": ["win-arm64", ".exe"],
  "x86_64-apple-darwin": ["macos-x64", ""],
  "aarch64-apple-darwin": ["macos-arm64", ""],
};

/** The triple Tauri will look for — `rustc -vV`'s `host:` line. */
function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m) throw new Error("could not read host triple from `rustc -vV`");
  return m[1].trim();
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const triple = flag("--target") ?? hostTriple();
const mapping = PKG_TARGET[triple];
if (!mapping) {
  throw new Error(`unsupported target triple: ${triple} — add it to PKG_TARGET in build.mjs`);
}
const [pkgArch, exeSuffix] = mapping;

const bundle = join(here, "dist", "sidecar.cjs");
const outDir = join(here, "..", "src-tauri", "binaries");
const outFile = join(outDir, `tallybot-sidecar-${triple}${exeSuffix}`);

console.error(`[build] target ${triple} → pkg ${NODE_RANGE}-${pkgArch}`);
console.error("[build] esbuild: src/main.ts → dist/sidecar.cjs (atem-connection external)");
await esbuild({
  entryPoints: [join(here, "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: NODE_RANGE,
  outfile: bundle,
  external: ["atem-connection"],
});

mkdirSync(outDir, { recursive: true });

// NixOS can't exec pkg's fetched base-node binary, so V8-bytecode generation fails
// (EPIPE) for every file. --fallback-to-source then ships plain JS — larger and
// readable, but correct. Real bytecode is produced everywhere else, including the
// Windows/macOS release builds, so this only relaxes the dev box.
const onNixOS = existsSync("/etc/NIXOS");

const pkgArgs = [bundle, "--targets", `${NODE_RANGE}-${pkgArch}`, "--output", outFile];
if (onNixOS) {
  console.error("[build] NixOS detected → --fallback-to-source (ships JS, not bytecode)");
  pkgArgs.push("--fallback-to-source");
}

console.error(`[build] pkg ${pkgArgs.join(" ")}`);
await pkgExec(pkgArgs);

console.error(`[build] done → ${outFile}`);

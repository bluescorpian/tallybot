# Building the Windows binary

A step-by-step guide to producing a portable (no-installer) Windows build of TallyBot,
written for someone who doesn't usually develop on Windows.

You must build **on a Windows machine**: `@yao-pkg/pkg` embeds a native Node runtime and
native deps per-OS, so a Windows sidecar binary has to be built on Windows. The general
recipe lives in [`docs/architecture.md`](architecture.md) → "Packaging the Sidecar → Building a
release"; this file is the Windows-specific walkthrough.

## Quick path: the script

[`scripts/win-build.ps1`](scripts/win-build.ps1) does everything below except cloning the
repo — installs the prerequisites via winget, installs deps, builds, and produces the
portable zip. After cloning, open an **Administrator** PowerShell at the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\win-build.ps1
```

If a freshly-installed tool isn't on PATH yet (it can take a new shell), open a new
terminal and re-run with `-SkipSetup` to jump straight to the build. Use `-SkipSetup` any
time the prerequisites are already installed. The rest of this document is the manual
version of what the script does — read it if the script fails or you want to understand a
step.

## 1. Prerequisites (one-time)

Install these four:

1. **Visual Studio C++ Build Tools** — Rust's linker on Windows. Download "Build Tools for
   Visual Studio", run it, and tick **"Desktop development with C++"**. (The single most
   commonly missed step — without it you get `link.exe not found`.)
2. **Rust** — install `rustup` from <https://rustup.rs>. On Windows it defaults to the
   `x86_64-pc-windows-msvc` toolchain, which is exactly the target triple we want.
3. **Node.js 22 LTS** — from <https://nodejs.org>. Then enable pnpm: in PowerShell run
   `corepack enable pnpm`.
4. **WebView2 runtime** — preinstalled on Windows 11 and recent Windows 10. If the app
   window is blank later, install the "Evergreen" runtime from Microsoft.

> You do **not** need Nix, `cargo-tauri`, or any of the Linux dev-shell setup. On Windows
> the `@tauri-apps/cli` npm package (already a devDependency) works natively, so we use
> `pnpm tauri` rather than `cargo tauri`. (The "use `cargo tauri`, not `pnpm tauri`" rule in
> `CLAUDE.md` is a NixOS-only workaround.) The NVIDIA + Wayland workaround is Linux-only and
> irrelevant here.

## 2. Get the code onto Windows

Either `git clone` the repo or copy the `tallybot` folder over. **Don't copy `node_modules`
or `target`** from Linux — they hold Linux binaries. `git clone` avoids this automatically
(both are gitignored).

## 3. Install dependencies

In PowerShell, from the repo root:

```powershell
cd tallybot\app\sidecar
pnpm install            # esbuild + @yao-pkg/pkg (+ fetches the win-x64 esbuild binary)
cd ..
pnpm install            # frontend deps
```

## 4. Smoke-test the sidecar binary first (recommended)

Before the full app build, confirm the sidecar packs and runs on its own — this isolates
the one historically-risky part:

```powershell
cd sidecar
pnpm run build:binary
```

This prints `target x86_64-pc-windows-msvc -> pkg node22-win-x64` and produces
`app\src-tauri\binaries\tallybot-sidecar-x86_64-pc-windows-msvc.exe`. On Windows there is
**no** `--fallback-to-source` (unlike the NixOS dev box), so you get real V8 bytecode. The
first run downloads the base Node runtime — needs internet.

Test it boots:

```powershell
..\src-tauri\binaries\tallybot-sidecar-x86_64-pc-windows-msvc.exe
```

You want a JSON line starting `{"type":"state"...}` followed by `tallybot sidecar started`.
Press **Ctrl+C** to stop. If you see that, the hard part works on Windows.

## 5. Build the full app

```powershell
cd ..              # back to tallybot\app
pnpm tauri build
```

This runs the frontend build + the sidecar binary build (via `beforeBuildCommand`),
compiles the Rust shell in release, and bundles. The main exe lands at:

```
app\src-tauri\target\release\TallyBot.exe
```

## 6. Make the portable zip (no installer)

`pnpm tauri build` also produces an `.msi`/`.exe` installer under `target\release\bundle\` —
**ignore those**; we want portable. For the zip you need two files side by side:

- `TallyBot.exe`
- `tallybot-sidecar.exe`  ← the sidecar, with the triple suffix **stripped**

At runtime the resolver looks for `tallybot-sidecar.exe` next to `TallyBot.exe`. Check
whether the build already dropped it into `target\release\`:

```powershell
dir target\release\tallybot-sidecar.exe
```

If it's there, zip the two together. If it's **not** there, copy it yourself (dropping the
triple suffix):

```powershell
copy src-tauri\binaries\tallybot-sidecar-x86_64-pc-windows-msvc.exe `
     src-tauri\target\release\tallybot-sidecar.exe
```

Then zip:

```powershell
Compress-Archive `
  -Path src-tauri\target\release\TallyBot.exe, src-tauri\target\release\tallybot-sidecar.exe `
  -DestinationPath TallyBot-portable-win-x64.zip
```

Unzip anywhere and run `TallyBot.exe` — it spawns the sidecar from its own folder, and
config is written to `%APPDATA%\com.tallybot.app\state.json` (set by the Rust shell), so
dropping in a newer zip doesn't wipe settings.

## Gotchas to expect

- **`link.exe not found` / linker errors** → the C++ Build Tools (step 1) weren't installed,
  or you need a fresh terminal after installing them.
- **Blank/white window** → WebView2 runtime missing (step 1.4).
- **pkg hangs on first build** → it's downloading the base Node runtime; needs network, only
  the first time.
- **SmartScreen warns "unrecognized app"** when running the unsigned exe → expected for an
  unsigned portable build; "More info → Run anyway". Code-signing is a separate, later
  concern.

## Open question to verify on the box

Whether step 6 needs the manual copy depends on whether Windows `pnpm tauri build` lands the
`externalBin` in `target\release\` next to the exe (it definitely puts it in the bundle).
The `dir` check in step 6 answers this in two seconds — note the result here once known.

<#
.SYNOPSIS
    Set up a Windows machine and produce a portable (no-installer) TallyBot build.

.DESCRIPTION
    Does everything except clone the repo:
      1. Installs the prerequisites via winget (VS C++ Build Tools, Rust, Node LTS,
         WebView2).
      2. Installs project dependencies (sidecar + frontend).
      3. Builds the app (which packages the sidecar binary via beforeBuildCommand).
      4. Assembles TallyBot.exe + tallybot-sidecar.exe into a portable zip.

    See PACKAGING-WINDOWS.md for the manual version of these steps and the rationale.

.NOTES
    Run in an **elevated** PowerShell (Administrator) - winget's machine-wide installs
    and `corepack enable` both want it.

    Installers update PATH at the machine/user level but NOT the current shell. This
    script refreshes PATH from the registry after the installs; if a freshly-installed
    tool still isn't visible (occasionally happens), just open a NEW terminal and
    re-run with -SkipSetup.

    If scripts are blocked, launch as:
        powershell -ExecutionPolicy Bypass -File scripts\win-build.ps1

.PARAMETER SkipSetup
    Skip the winget prerequisite installs (use once the tools are already installed).

.PARAMETER SkipBuild
    Only install prerequisites; don't build or zip.

.PARAMETER Zip
    Output zip path (relative to repo root). Default: TallyBot-portable-win-x64.zip
#>
[CmdletBinding()]
param(
    [switch]$SkipSetup,
    [switch]$SkipBuild,
    [string]$Zip = 'TallyBot-portable-win-x64.zip'
)

$ErrorActionPreference = 'Stop'

# --- paths -----------------------------------------------------------------
# scripts/ sits at the repo root, so the repo root is this script's parent's parent.
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$AppDir     = Join-Path $RepoRoot 'app'
$SidecarDir = Join-Path $AppDir 'sidecar'
$Triple     = 'x86_64-pc-windows-msvc'   # winget Rust default on Windows x64

# --- helpers ---------------------------------------------------------------
function Have([string]$cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Refresh-Path {
    # Re-read PATH from the registry so tools installed during this run become callable
    # without opening a new shell.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = ($machine, $user | Where-Object { $_ }) -join ';'
}

function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Is-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

# ===========================================================================
# 1. Prerequisites
# ===========================================================================
if (-not $SkipSetup) {
    if (-not (Have winget)) {
        throw "winget not found. Install 'App Installer' from the Microsoft Store, then re-run."
    }
    if (-not (Is-Admin)) {
        Write-Warning "Not running as Administrator - machine-wide installs and 'corepack enable' may fail. Consider re-launching elevated."
    }

    $common = @('-e', '--accept-source-agreements', '--accept-package-agreements')

    Step "Visual Studio C++ Build Tools (with VCTools workload)"
    # winget alone installs the shell but not the C++ workload, so pass it through.
    winget install --id Microsoft.VisualStudio.2022.BuildTools @common `
        --override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

    if (-not (Have rustc)) {
        Step "Rust (rustup)"
        winget install --id Rustlang.Rustup @common
    } else { Step "Rust already present - skipping" }

    if (-not (Have node)) {
        Step "Node.js LTS"
        winget install --id OpenJS.NodeJS.LTS @common
    } else { Step "Node already present - skipping" }

    Step "WebView2 runtime"
    winget install --id Microsoft.EdgeWebView2Runtime @common

    Refresh-Path

    if (-not (Have pnpm)) {
        Step "Enabling pnpm via corepack"
        corepack enable pnpm
        Refresh-Path
    }
}

if ($SkipBuild) {
    Step "Setup done (-SkipBuild given). Open a new terminal and run with -SkipSetup to build."
    return
}

# ===========================================================================
# 2. Verify the toolchain is callable in THIS session
# ===========================================================================
$missing = @('node', 'pnpm', 'cargo') | Where-Object { -not (Have $_) }
if ($missing) {
    throw ("Not on PATH in this session: {0}. The installs landed, but PATH didn't refresh " +
           "- open a NEW PowerShell window and re-run with -SkipSetup." -f ($missing -join ', '))
}

# ===========================================================================
# 3. Install deps + build
# ===========================================================================
Step "Installing sidecar dependencies"
Push-Location $SidecarDir
try { pnpm install } finally { Pop-Location }

Step "Installing frontend dependencies"
Push-Location $AppDir
try {
    pnpm install
    Step "Building the app (frontend + sidecar binary + Rust shell)"
    pnpm tauri build
} finally { Pop-Location }

# ===========================================================================
# 4. Assemble the portable zip
# ===========================================================================
$ReleaseDir = Join-Path $AppDir 'src-tauri\target\release'
$Exe        = Join-Path $ReleaseDir 'TallyBot.exe'
$Sidecar    = Join-Path $ReleaseDir 'tallybot-sidecar.exe'

if (-not (Test-Path $Exe)) { throw "Build did not produce $Exe" }

# Tauri puts the sidecar in the installer bundle; whether it also lands next to the exe in
# target\release varies. If it's not there, copy it (dropping the triple suffix the runtime
# resolver doesn't want).
if (-not (Test-Path $Sidecar)) {
    $Built = Join-Path $AppDir "src-tauri\binaries\tallybot-sidecar-$Triple.exe"
    if (-not (Test-Path $Built)) { throw "Sidecar binary not found at $Built" }
    Step "Copying sidecar next to the exe"
    Copy-Item $Built $Sidecar
}

$ZipPath = Join-Path $RepoRoot $Zip
Step "Zipping -> $ZipPath"
Compress-Archive -Path $Exe, $Sidecar -DestinationPath $ZipPath -Force

Write-Host ""
Write-Host "Done. Portable build: $ZipPath" -ForegroundColor Green
Write-Host "Unzip anywhere and run TallyBot.exe (config goes to %APPDATA%\com.tallybot.app)." -ForegroundColor Green

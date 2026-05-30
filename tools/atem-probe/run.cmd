@echo off
REM ============================================================================
REM  TallyBot ATEM Probe - one-click launcher for Windows.
REM
REM  Double-click this file. It will:
REM    1. Install Node.js automatically if it isn't already present.
REM    2. Install the tool's dependencies on first run.
REM    3. Start the probe and open it in your browser.
REM  Keep this window open while testing - it is also the live log.
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title TallyBot ATEM Probe

echo(
echo   ===========================================
echo    TallyBot ATEM Probe
echo   ===========================================
echo(

REM --- 1. Ensure Node.js is installed ------------------------------------------
where node >nul 2>nul && goto have_node

call :install_node

where node >nul 2>nul && goto have_node
echo(
echo   [X] Node.js could not be installed automatically.
echo       Please install the "LTS" version from https://nodejs.org/ and run this
echo       file again. Opening the download page now...
start "" https://nodejs.org/
echo(
pause
exit /b 1

:have_node
for /f "delims=" %%v in ('node --version') do set "NODEVER=%%v"
echo   [ok] Node.js !NODEVER! found.

REM --- 2. Ensure dependencies are installed (first run does this) --------------
if not exist "node_modules\" (
  echo   [..] First run: installing dependencies. This can take a minute...
  call npm install
  if errorlevel 1 (
    echo(
    echo   [X] Dependency install failed - see the messages above.
    pause
    exit /b 1
  )
  echo   [ok] Dependencies installed.
) else (
  echo   [ok] Dependencies already installed.
)

REM --- 3. Run. Newer Node strips TypeScript types automatically; older Node
REM        needs a flag. Use the flag only if this Node accepts it. ------------
set "STRIP="
node --experimental-strip-types -e "0" >nul 2>nul
if not errorlevel 1 set "STRIP=--experimental-strip-types"

echo   [..] Starting the probe. A browser tab will open at http://127.0.0.1:4848
echo        Press Ctrl+C or close this window to stop.
echo(
node !STRIP! src/main.ts

echo(
echo   Probe stopped.
pause
exit /b 0

REM ============================================================================
REM  Subroutines
REM ============================================================================

:install_node
echo   [..] Node.js not found - attempting to install it automatically.
echo       If a security (UAC) prompt appears, choose "Yes".
echo(

REM 1a. Preferred: winget (built into Windows 10 1809+ / Windows 11).
where winget >nul 2>nul || goto install_node_msi
echo   [..] Installing Node.js LTS via winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
call :refresh_path
where node >nul 2>nul && goto :eof
echo   [..] winget did not complete - falling back to a direct download...

REM 1b. Fallback: download the official MSI and run it.
:install_node_msi
set "NODE_LTS=v22.13.0"
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
set "MSI=%TEMP%\node-%NODE_LTS%-%ARCH%.msi"
set "URL=https://nodejs.org/dist/%NODE_LTS%/node-%NODE_LTS%-%ARCH%.msi"
echo   [..] Downloading %URL%
where curl >nul 2>nul && curl -L -o "%MSI%" "%URL%"
if not exist "%MSI%" powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%URL%' -OutFile '%MSI%' } catch { exit 1 }"
if not exist "%MSI%" (
  echo   [X] Download failed.
  goto :eof
)
echo   [..] Running the Node.js installer ^(accept the prompt^)...
powershell -NoProfile -Command "Start-Process msiexec -ArgumentList '/i','%MSI%','/passive','/norestart' -Verb RunAs -Wait"
call :refresh_path
goto :eof

:refresh_path
REM A freshly installed Node isn't on this window's PATH yet (PATH changes only
REM reach new processes). Add its known install location so we can use it now.
set "PATH=%PATH%;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs"
goto :eof

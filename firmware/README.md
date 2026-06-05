# Firmware

ESP32-C3 device firmware — the **tally light** end of TallyBot. On the wire it's a TCP
*client*: it discovers the sidecar over UDP, connects, sends `HELLO` then `HEARTBEAT`s,
and applies `SET_COLOR` / `IDENTIFY` commands to the onboard LED. See
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the protocol and
[`../PHASES.md`](../PHASES.md) for the build sequence.

> **Status — hello-world scaffold.** This is the toolchain bring-up, not the tally
> client. [`src/main.cpp`](src/main.cpp) drives the onboard LED through the product's
> colour palette and prints the device's MAC over USB. No WiFi, no discovery, no
> protocol yet — that's Phase 3 (see [Next](#next)).

## Hardware

ESP32-C3 SuperMini V2 — single-core RISC-V, WiFi, USB-C. The onboard addressable RGB
LED (WS2812) is on **GPIO8**. PlatformIO target: `esp32-c3-devkitm-1`, Arduino framework.

## Develop

PlatformIO provides the toolchain. On this NixOS box `pio` is installed globally (it's
intentionally *not* in `flake.nix`, which covers the Tauri app only) — run it directly,
no dev shell needed.

```bash
pio run              # build
pio run -t upload    # flash (board attached over USB-C)
pio device monitor   # serial @ 115200
```

`pio run` on its own validates the scaffold, toolchain, and library resolution with no
hardware attached. The upload/monitor steps need a physical board.

Expected monitor output:

```
=== TallyBot firmware — hello world ===
chip: ESP32-C3 rev 4, 1 core(s)
MAC:  AA:BB:CC:DD:EE:FF
LED self-test running (red, green, blue, dim white, off)...
MAC: AA:BB:CC:DD:EE:FF — LED cycle
  LED: live    (red)
  ...
```

…and the onboard LED stepping red → green → blue → dim-white → off on a 1 s beat.

## Board gotchas (these will bite you)

1. **GPIO8 is addressable, not digital.** `digitalWrite(8, …)` does nothing and the
   board looks dead. Drive the LED via FastLED only.
2. **USB serial needs the CDC flags.** The SuperMini's USB-C is the chip's native USB
   Serial/JTAG, not a UART bridge. `Serial` only reaches the monitor because
   `platformio.ini` sets `ARDUINO_USB_MODE=1` and `ARDUINO_USB_CDC_ON_BOOT=1`. Drop
   them and the board flashes fine but the monitor stays blank.
3. **Never sleep.** Deep/light sleep lets a USB power bank's auto-off cut power
   (low-current detection). Keep busy; the hello-world `loop()` never sleeps.
4. **WiFi TX-power fallback (Phase 3).** On older C3 boards, call
   `WiFi.setTxPower(WIFI_POWER_8_5dBm)` before `WiFi.begin()` if WiFi won't connect.

If `pio device monitor` can't find the port, list candidates with `pio device list`
(typically `/dev/ttyACM0` for the native-USB C3).

## Next

Phase 3 turns this scaffold into the tally client (see [`../PHASES.md`](../PHASES.md)):

- `src/protocol.h` — `#define`s mirroring [`../app/sidecar/src/protocol.ts`](../app/sidecar/src/protocol.ts)
  (ports, message types, version, colours, framing). Keep the two in lockstep.
- WiFi provisioning (WiFiManager captive portal) + credential persistence to NVS.
- UDP discovery (`TALLY_FIND` → `TALLY_HERE:<port>`), TCP connect, auto-reconnect.
- The wire protocol: `HELLO` on connect, `HEARTBEAT` every 10 s, decode
  `SET_COLOR` / `IDENTIFY`; device-local steady blue when the server is lost.

It can be built and tested against the standalone sidecar and the fake-device tools in
[`../tools/`](../tools) — no real ATEM or hardware required.

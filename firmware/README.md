# Firmware

ESP32-C3 device firmware — the **tally light** end of TallyBot. On the wire it's a TCP
*client*: it discovers the sidecar over UDP, connects, sends `HELLO` then `HEARTBEAT`s,
and applies `SET_COLOR` / `IDENTIFY` commands to the onboard LED. See
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the protocol and
[`../PHASES.md`](../PHASES.md) for the build sequence.

> **Status — tally client (Phase 3).** [`src/main.cpp`](src/main.cpp) is the full
> device: WiFi provisioning via a captive portal, UDP discovery, the TCP binary
> protocol (`HELLO` / `HEARTBEAT` / `SET_COLOR` / `IDENTIFY`), and the LED state
> machine. The wire format lives in [`src/protocol.h`](src/protocol.h), the C++
> mirror of [`../app/sidecar/src/protocol.ts`](../app/sidecar/src/protocol.ts) — keep
> the two in lockstep.

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

`pio run` on its own validates the firmware, toolchain, and library resolution with no
hardware attached. The upload/monitor steps need a physical board.

Expected monitor output (first boot, before WiFi is provisioned):

```
=== TallyBot tally light ===
chip: ESP32-C3 rev 4
MAC:  aa:bb:cc:dd:ee:ff   AP: TallyLight-DDEEFF
Config portal up — join WiFi AP "TallyLight-DDEEFF", then open 192.168.4.1
```

Once provisioned and a server is found:

```
WiFi connected, IP 192.168.1.42
Found server at 192.168.1.10:7000
Connected to 192.168.1.10:7000; HELLO sent
SET_COLOR rgb(255,0,0) brightness=128
```

### Test it without hardware on the bench

The device half of the protocol can be exercised against the standalone sidecar dev
runner — no ATEM, no app, no UI. From the repo root:

```bash
cd tools && pnpm sidecar-dev      # binds TCP 7000 / UDP 7001; drive program/preview here
```

Then flash a board (`pio run -t upload && pio device monitor`), provision it onto the
same subnet, and it appears in the `sidecar-dev` REPL by its MAC. Driving program/preview
changes the LED; triggering IDENTIFY flashes it; killing the runner turns it steady blue.

### LED meaning

| LED | State | Driven by |
|-----|-------|-----------|
| Magenta | Captive portal up — join `TallyLight-XXXXXX` | device |
| Steady blue | No trusted server: connecting / discovering / dropped | device |
| Red / green / dim-white | Live / preview / idle | server |
| Flashing blue | Source can't be trusted (fault) | server |
| Brief white flash | IDENTIFY — locate this device | server-triggered |

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

## How it works

A non-blocking state machine in `loop()`:

```
PROVISIONING → DISCOVERING → CONNECTING → CONNECTED → BACKOFF → (rediscover)
```

- **Provisioning** — `WiFiManager.autoConnect` tries saved NVS credentials, else raises
  the `TallyLight-XXXXXX` SoftAP captive portal. Blocking is fine here (the device isn't
  on tally duty yet); the AP re-arms only on a later sustained WiFi loss, not while
  connected.
- **Discovering** — broadcasts `TALLY_FIND` to `255.255.255.255:7001` every 2 s. The UDP
  socket is bound to 7001 so it catches both the server's unicast reply and its periodic
  broadcast; `TALLY_HERE:<port>` yields the server IP and TCP port.
- **Connected** — sends `HELLO` immediately, `HEARTBEAT` every 10 s, and feeds every TCP
  read through a length-prefix `FrameDecoder` to dispatch `SET_COLOR` / `IDENTIFY`. A drop
  falls back to steady blue and re-discovers after a short backoff.

The `SET_COLOR` **brightness byte is perceptual**, so the firmware gamma-corrects it
(FastLED `applyGamma_video`, γ≈2.5) before driving the LED — the device is the single home
for that correction, so the sidecar and UI keep their 0–255 / 0–10 mappings linear
(`../ARCHITECTURE.md`, "Brightness is a perceptual value").

`src/protocol.h` is the cross-language contract — constants, framing, and the
encode/decode helpers — and must stay in lockstep with the sidecar's `protocol.ts`.

## Next

The firmware is independent of the rest of the app once the protocol is fixed. Remaining
work lives elsewhere (see [`../PHASES.md`](../PHASES.md)): Phase 5 wires the sidecar into
the Tauri shell and packages it. Firmware OTA updates are a roadmap item
([`../ARCHITECTURE.md`](../ARCHITECTURE.md)), not part of v1.

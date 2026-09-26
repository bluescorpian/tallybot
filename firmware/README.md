# Firmware

ESP32-C3 device firmware — the **tally light** end of TallyBot. On the wire it's a TCP
*client*: it discovers the sidecar over UDP, connects, sends `HELLO` then `HEARTBEAT`s,
and renders the `SET_COLOR` commands it streams on the onboard LED. The protocol is
defined in [`src/protocol.h`](src/protocol.h), mirroring the sidecar's `protocol.ts`.

> **Status — tally client.** The firmware is split into focused modules under `src/`:
> `led` (rendering + state machine), `wifi` (connection, captive portal, diagnostics),
> `usb` (USB-CDC COBS control channel), `tally` (UDP discovery + TCP client), `control`
> (message dispatch + STATUS), and `settings` (NVS), wired by `main.cpp`. Together they
> give WiFi provisioning via a captive portal, UDP discovery, the TCP binary protocol
> (`HELLO` / `HEARTBEAT` / `SET_COLOR` / `IDENTIFY`), USB provisioning, and the LED state
> machine. The wire format lives in [`src/protocol.h`](src/protocol.h), the C++ mirror of
> [`../app/sidecar/src/protocol.ts`](../app/sidecar/src/protocol.ts) — keep the two in lockstep.

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

#### Which build target?

There are two PlatformIO envs, and the choice matters once USB is involved:

| Goal | Env | Why |
|------|-----|-----|
| Debug firmware at a terminal | `esp32-c3-devkitm-1` (default) | Plain-text logs, so `pio device monitor` is readable and crash backtraces symbolise. |
| **Test USB comms with the host app** | **`esp32-c3-release`** | Frames *every* byte as COBS, so the host's decoder reads the stream cleanly. |

```bash
pio run -e esp32-c3-release -t upload   # flash the release build for host USB testing
```

**Why you can't use the dev build for USB-comms testing:** the dev build prints plain-text
logs onto the *same* USB wire as the COBS control frames. That's great for a human reading
the monitor, but it corrupts the host's COBS decoder. Any end-to-end USB test (device
detect, `SET_COLOR`, WiFi provisioning via the Tauri app) must run the release build. The
trade-off: release loses symbolised crash backtraces, since the exception decoder needs the
plain-text stream — so it's two modes, not one strictly-better build.

Expected monitor output (first boot, before WiFi is provisioned):

```
=== TallyBot === AP TallyLight-DDEEFF
Config portal up - join "TallyLight-DDEEFF", then open 192.168.4.1
```

Once provisioned and a server is found:

```
WiFi connected, IP 192.168.1.42
Found server 192.168.1.10:7000
Connected 192.168.1.10:7000; HELLO sent
SET_COLOR rgb(255,0,0) bri=128
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
4. **WiFi runs at full TX power, never capped.** Capping (`WIFI_POWER_8_5dBm`) slashes
   uplink range on venue APs. The firmware sets `WIFI_POWER_19_5dBm` and leaves it there.

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
  connected. **To switch networks deliberately, hold the on-board BOOT button (~3 s)** at
  any time — the LED turns magenta and the portal reopens, without erasing the current
  creds (enter a new network to overwrite, or close the portal to keep the old one). Join
  the SoftAP with a phone and the landing page shows a **diagnostics panel** (last WiFi
  failure reason, SSID tried, stored-password length, RSSI, MAC) — a serial monitor over
  WiFi when no USB is attached.
- **Discovering** — broadcasts `TALLY_FIND` to `255.255.255.255:7001` every 2 s. The UDP
  socket is bound to 7001 so it catches both the server's unicast reply and its periodic
  broadcast; `TALLY_HERE:<port>` yields the server IP and TCP port.
- **Connected** — sends `HELLO` immediately, `HEARTBEAT` every 10 s, and feeds every TCP
  read through a length-prefix `FrameDecoder` to dispatch `SET_COLOR` / `IDENTIFY`. A drop
  falls back to steady blue and re-discovers after a short backoff.

The `SET_COLOR` **brightness byte is perceptual**, so the firmware gamma-corrects it
(FastLED `applyGamma_video`, γ≈2.5) before driving the LED — the device is the single home
for that correction, so the sidecar and UI keep their 0–255 / 0–10 mappings linear.

`src/protocol.h` is the cross-language contract — constants, framing, and the
encode/decode helpers — and must stay in lockstep with the sidecar's `protocol.ts`.

## Next

The firmware is independent of the rest of the app once the protocol is fixed. Remaining
work lives elsewhere. Firmware OTA updates are on the roadmap (see the repo README), not
part of v1.

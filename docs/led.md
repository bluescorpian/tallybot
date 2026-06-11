# LED.md — TallyBot device LED states

> **Status: implemented & verified (June 2026).** This is the source of truth for the LED
> palette, from the field test (see
> [`docs/archive/field-test-venue-1.md`](archive/field-test-venue-1.md), Issue 3). The
> **device-local** states (boot self-test, provisioning, joining/lost-WiFi, searching,
> lost-server, the 10% local brightness, the connect-gap breathe) are live in the firmware's
> [`led.cpp`](../firmware/src/led.cpp) + [`indicators.h`](../firmware/src/indicators.h); the **server-driven** states
> (live/preview/idle steady, the fault flash, and the unassigned white breathe) are live in the
> sidecar ([`app/sidecar/src/app.ts`](../app/sidecar/src/app.ts),
> [`engine.ts`](../app/sidecar/src/engine.ts)), with `SETUP_COLOR` now white in
> [`protocol.ts`](../app/sidecar/src/protocol.ts).
>
> **Architecture: the firmware is lean; the server owns connected-state animation.** Once a
> device is talking to the sidecar, *all* motion (the fault flash, the unassigned breathe) is
> driven by the server streaming frames over the wire — the firmware just renders each static
> `SET_COLOR` it's sent. The device animates *only* during bring-up (provisioning → searching),
> where there's no server connected to drive it. This keeps device firmware simple and puts the
> behaviour where it's easy to change.

The tally light has a **single** WS2812 LED on GPIO8. State is therefore carried by two
axes: **hue** and **motion** (steady / pulse / slow-blink / fast-blink / flash). The design
rule is **no hue means two different things**, and **motion encodes diagnosis** where hues
must be related (the two blues; the amber WiFi family).

## Design rules

1. **Every bring-up phase has a unique, unshared colour.** You can read a device's phase
   from across the room without guessing.
2. **Motion is meaningful, not decoration.** Pulse = "working on it"; slow blink =
   "searching"; fast blink = "lost something, retrying"; steady = "settled in this state";
   flash burst = locate (find this device).
3. **Colour tells you *which box to go look at*.**
   - **Magenta** → the **device** needs setup (join its SoftAP).
   - **Amber** → a **WiFi/network** problem (check the AP / range).
   - **Blue** → **WiFi is fine, the TallyBot PC/app** is the problem (check the computer).
   - **Red/Green/White** → normal tally (the show is running).
4. **Never show a false "clear."** Idle dim-white is only ever server-driven and only when
   the source is genuinely trusted (see `docs/architecture.md`, "Failure signalling"). Device-local
   uncertainty is never dim-white.

## The states

| # | State | Hue | Motion | Driven by | Meaning / what to do |
|---|-------|-----|--------|-----------|----------------------|
| 0 | **Boot self-test** | R → G → B → W | ~1s sweep, once | device | Power-on check that the LED + driver are alive, before any state colour. |
| 1 | **Provisioning** | Magenta `255,0,255` | Steady | device | No saved WiFi. SoftAP `TallyLight-XXXXXX` is up — join it and enter WiFi creds at `192.168.4.1`. |
| 2 | **Joining WiFi** | Amber `255,120,0` | Slow pulse | device | Has creds, associating with the saved AP. |
| 3 | **Lost WiFi** | Amber `255,120,0` | Fast blink | device | Had WiFi, the AP/range dropped. **Network problem** — check the access point. Auto-reconnects; after a sustained outage falls back to Provisioning (1). |
| 4 | **Searching for server** | Cyan `0,255,255` | Smooth pulse | device | WiFi is up; broadcasting discovery + opening TCP to the sidecar. Never reached the server *yet*. Smooth (not blinking) to stay low-distraction in a live venue. (An ESP-NOW light hunting for its bridge shows this same state — the bridge *is* its path to the server.) |
| 5 | **Connected, unassigned** | White `255,255,255` | Slow breathe, ~10s | server* | Online and talking to TallyBot, but not assigned to an ATEM input. Assign it in the app. |
| 6 | **Live** | Red `255,0,0` | Steady | server | Assigned input is on Program. |
| 7 | **Preview** | Green `0,255,0` | Steady | server | Assigned input is on Preview. |
| 8 | **Idle** | Dim white `30,30,30` | Steady | server | Assigned, not selected, **source trusted** ("you're clear"). |
| 9 | **Fault** | Blue `0,0,255` | Flashing | server | Assigned, but the **source can't be trusted** (ATEM down/unknown). Don't trust this light. |
| 10 | **Lost the server** | Blue `0,0,255` | Steady | device | WiFi is fine but the TallyBot server went away (app closed / PC asleep / sidecar crashed). **PC/app problem** — check the computer. Auto-rediscovers. (An ESP-NOW light that loses its bridge link shows this same state: its upstream is the bridge at the PC, so the operator's "check the computer" read stays correct. The amber states never apply to ESP-NOW lights — they have no AP.) |
| 11 | **Locate** | White `255,255,255` | ~6 flashes | server | Find this physical device. The server streams a white/off burst over the current colour, then resumes it. |

\* **State 5** is **server-driven**: the sidecar holds the white setup colour and streams the
breathe as a brightness envelope over the wire (the same mechanism as the fault flash — see
[`app.ts`](../app/sidecar/src/app.ts) `#applyColors`), so the firmware stays lean and renders
each static `SET_COLOR` as sent. During the brief gap between TCP connect and the first server
message, the device shows the *same* white breathe **locally** (the one connected-state colour
it renders itself), so there is no blue flash at hand-off.

### The three whites are distinguished by brightness + motion

White now appears in three states, all kept apart without a hue change:
- **Idle (8)** — *dim* (`30,30,30`), **steady**. The only "you're clear" signal; never moves.
- **Unassigned (5)** — *full* white, **slow breathe** (~10s). Obviously alive and in motion.
- **Locate (11)** — *full* white, **sharp flash burst** (~6 fast toggles), then restores.

A steady dim glow, a slow swell, and a rapid strobe read as three different things at a
glance. Idle stays the only static white, preserving the "never a false clear" rule.

## Why the two blues, and why amber vs blue

`docs/architecture.md` keeps **two blues, one meaning — "don't trust this light"**: **steady**
blue is device-local (it lost the server), **flashing** blue is server-driven (the source is
untrusted). We preserve that. The new split is one level up:

- **Amber = WiFi-side trouble** (states 2/3): the device can't reach the *network*.
- **Blue = server-side trouble** (states 9/10): the *network is fine*, but either the
  TallyBot server is gone (steady, device-local) or the ATEM source is untrusted (flashing,
  server-driven).

So the operator's first read — amber vs blue — already routes them to the right box: the
**access point** vs the **streaming PC**.

## Colours retired / changed from the old scheme

- **Magenta** no longer doubles as "connected-but-unassigned" — that becomes the **white
  slow breathe** (state 5). Magenta is now *only* Provisioning (state 1).
- **Steady blue** no longer means six things. It is now *only* "lost the TallyBot server"
  (state 10). "Joining/lost WiFi" → amber (2/3); "searching for server" → cyan (4).
- The sidecar's `SETUP_COLOR` (`protocol.ts`) is now white (was magenta), driven as a
  server-side breathe (see note above); the firmware's `COLOR_*` set in `protocol.h` gained the
  amber/cyan device-local colours and stays in lockstep. Note the firmware's own `COLOR_SETUP`
  (magenta) is a *different* thing — the device-local **provisioning** hint — and stays magenta.

## Decisions locked (June 2026)

- **Unassigned = white, slow breathe (~10s).** Distinguished from idle (dim, steady) and
  the locate strobe (sharp flash) by brightness + motion, per above.
- **Amber = the WiFi family** (joining = pulse, lost-WiFi = fast blink); **blue = server-side**
  (lost server steady / fault flashing). First read amber-vs-blue routes the operator to the
  AP vs the PC.
- **Boot self-test = yes** — a ~1s R→G→B→W sweep at power-on (state 0).

## Resolved decisions

- **How the server signals "unassigned"** — *no protocol change.* The sidecar sends the white
  setup colour via the normal `SET_COLOR` and streams the breathe as a brightness envelope (like
  the fault flash). The brief connect-gap breathe is the only one rendered locally on the device.
- **Animation lives in the server.** The firmware renders static frames for every connected
  state; the sidecar owns the flash and breathe waveforms. Bring-up states animate locally only
  because no server is connected yet.

## Tuning notes

- **Exact amber/cyan RGB + brightness, and the breathe/pulse/blink periods** are still worth
  tuning on real hardware; the values here (breathe ~10 s, 10–100%; flash ~1 Hz) are the
  starting point. Device-local indicators use `LOCAL_BRIGHTNESS`, not the gamma-corrected server
  brightness; the server-driven breathe modulates the device's configured brightness.

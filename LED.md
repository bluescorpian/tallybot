# LED.md — TallyBot device LED states

> **Status: device-local states implemented & bench-verified (June 2026); server-driven
> states pending.** This is the source of truth for the LED palette, from the field test
> (see [`FIELD-TEST-FINDINGS.md`](FIELD-TEST-FINDINGS.md), Issue 3). The **device-local**
> states (boot self-test, provisioning, joining/lost-WiFi, searching, lost-server, plus the
> 10% local brightness and the connect-gap white breathe) are live in
> [`firmware/src/main.cpp`](firmware/src/main.cpp). Still **pending** (needs the sidecar): the
> server-driven states (live/preview/idle/fault) and changing the `SETUP_COLOR` in
> [`app/sidecar/src/protocol.ts`](app/sidecar/src/protocol.ts) from magenta to the white
> breathe. `ARCHITECTURE.md` / `DESIGN.md` should link here.

The tally light has a **single** WS2812 LED on GPIO8. State is therefore carried by two
axes: **hue** and **motion** (steady / pulse / slow-blink / fast-blink / flash). The design
rule is **no hue means two different things**, and **motion encodes diagnosis** where hues
must be related (the two blues; the amber WiFi family).

## Design rules

1. **Every bring-up phase has a unique, unshared colour.** You can read a device's phase
   from across the room without guessing.
2. **Motion is meaningful, not decoration.** Pulse = "working on it"; slow blink =
   "searching"; fast blink = "lost something, retrying"; steady = "settled in this state";
   flash burst = IDENTIFY.
3. **Colour tells you *which box to go look at*.**
   - **Magenta** → the **device** needs setup (join its SoftAP).
   - **Amber** → a **WiFi/network** problem (check the AP / range).
   - **Blue** → **WiFi is fine, the TallyBot PC/app** is the problem (check the computer).
   - **Red/Green/White** → normal tally (the show is running).
4. **Never show a false "clear."** Idle dim-white is only ever server-driven and only when
   the source is genuinely trusted (see `ARCHITECTURE.md`, "Failure signalling"). Device-local
   uncertainty is never dim-white.

## The states

| # | State | Hue | Motion | Driven by | Meaning / what to do |
|---|-------|-----|--------|-----------|----------------------|
| 0 | **Boot self-test** | R → G → B → W | ~1s sweep, once | device | Power-on check that the LED + driver are alive, before any state colour. |
| 1 | **Provisioning** | Magenta `255,0,255` | Steady | device | No saved WiFi. SoftAP `TallyLight-XXXXXX` is up — join it and enter WiFi creds at `192.168.4.1`. |
| 2 | **Joining WiFi** | Amber `255,120,0` | Slow pulse | device | Has creds, associating with the saved AP. |
| 3 | **Lost WiFi** | Amber `255,120,0` | Fast blink | device | Had WiFi, the AP/range dropped. **Network problem** — check the access point. Auto-reconnects; after a sustained outage falls back to Provisioning (1). |
| 4 | **Searching for server** | Cyan `0,255,255` | Smooth pulse | device | WiFi is up; broadcasting discovery + opening TCP to the sidecar. Never reached the server *yet*. Smooth (not blinking) to stay low-distraction in a live venue. |
| 5 | **Connected, unassigned** | White `255,255,255` | Slow breathe, ~10s | server* | Online and talking to TallyBot, but not assigned to an ATEM input. Assign it in the app. |
| 6 | **Live** | Red `255,0,0` | Steady | server | Assigned input is on Program. |
| 7 | **Preview** | Green `0,255,0` | Steady | server | Assigned input is on Preview. |
| 8 | **Idle** | Dim white `30,30,30` | Steady | server | Assigned, not selected, **source trusted** ("you're clear"). |
| 9 | **Fault** | Blue `0,0,255` | Flashing | server | Assigned, but the **source can't be trusted** (ATEM down/unknown). Don't trust this light. |
| 10 | **Lost the server** | Blue `0,0,255` | Steady | device | WiFi is fine but the TallyBot server went away (app closed / PC asleep / sidecar crashed). **PC/app problem** — check the computer. Auto-rediscovers. |
| 11 | **IDENTIFY** | White `255,255,255` | ~6 flashes | server-triggered | Locate this physical device. Flashes over the current colour, then restores it. |

\* **State 5** is signalled by the server, but the **slow breathe is rendered on the
device** (the wire `SET_COLOR` is a static RGB+brightness — it can't carry an animation).
During the brief gap between TCP connect and the first server message, the device shows the
*same* white breathe locally, so there is no blue flash at hand-off. **Implementation note:**
decide how the server says "you're unassigned" without churning the protocol — either keep
sending the unassigned `SET_COLOR` and have the device animate when it recognises that
colour, or add a lightweight "unassigned" signal. (See open questions.)

### The three whites are distinguished by brightness + motion

White now appears in three states, all kept apart without a hue change:
- **Idle (8)** — *dim* (`30,30,30`), **steady**. The only "you're clear" signal; never moves.
- **Unassigned (5)** — *full* white, **slow breathe** (~10s). Obviously alive and in motion.
- **IDENTIFY (11)** — *full* white, **sharp flash burst** (~6 fast toggles), then restores.

A steady dim glow, a slow swell, and a rapid strobe read as three different things at a
glance. Idle stays the only static white, preserving the "never a false clear" rule.

## Why the two blues, and why amber vs blue

`ARCHITECTURE.md` keeps **two blues, one meaning — "don't trust this light"**: **steady**
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
- The sidecar's `SETUP_COLOR` (`protocol.ts`) changes magenta → white (rendered as a breathe
  on the device, see note above); the firmware's `COLOR_*` set in `protocol.h` gains the
  amber/cyan device-local colours and must stay in lockstep.

## Decisions locked (June 2026)

- **Unassigned = white, slow breathe (~10s).** Distinguished from idle (dim, steady) and
  IDENTIFY (sharp flash) by brightness + motion, per above.
- **Amber = the WiFi family** (joining = pulse, lost-WiFi = fast blink); **blue = server-side**
  (lost server steady / fault flashing). First read amber-vs-blue routes the operator to the
  AP vs the PC.
- **Boot self-test = yes** — a ~1s R→G→B→W sweep at power-on (state 0).

## Open questions (need sign-off before implementing)

- **How the server signals "unassigned"** without a protocol change, so the device can render
  the white breathe locally (see the state-5 implementation note). Default: device animates
  when it sees the unassigned colour from the server; the connect-gap breathe is purely local.
- **Exact amber/cyan RGB + brightness, and the breathe/pulse/blink periods**, want tuning on
  real hardware; the values above are a starting point. Device-local indicators use
  `LOCAL_BRIGHTNESS`, not the gamma-corrected server brightness.

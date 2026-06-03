# TallyBot — UI Design

The **visual and interaction design** for the desktop app. This is frontend-only context:
backend, protocol, and schema work doesn't need it, and it shouldn't bleed into those
sessions.

It builds on the model in [`GOALS.md`](GOALS.md) — *source*, *input*, *device/light*,
*assignment*, *program/preview/idle*, the unassigned *setup colour*, and the program
*override*. Where `GOALS.md` defines behavioural intent, this file defines what the UI
looks like and how you manipulate it.

---

## Concept — a circuit-board schematic

The main view reads like a **PCB schematic**, but it's structured as a **table** so the
wiring is never dynamic. A **source** (the ATEM) feeds a **row of inputs** laid out
left-to-right like the physical switcher. Each input heads a **column**; the **lights**
assigned to it sit in that column, directly beneath it. Because position encodes the
connection, the **PCB-style traces** (angular lines) are short and static — they don't
re-route as you assign. Between the inputs and the lights, every trace pinches through a
single **program-output gate**, where an **override** can block them all at once.

---

## Layout (top → bottom)

- **Source** spans the top as a bar/"chip"; the inputs are its pins.
- **Inputs** are the focus: a **horizontal row** echoing the switcher's button strip. Each
  input is the **header of a column**.
- **Program-output gate** sits in the gutter between inputs and lights: all traces
  converge to it and fan back out below — the converge-then-diverge "X". An **override
  source** wires into it from the **right**, but that element is **hidden until an override
  source (OBS) is configured**, so v1 shows none.
- **Connected lights** sit in a **table**, each in its input's column, directly below the
  gate; each shows a **MAC tail** (no user names — lights sharing an input are told apart
  by flashing). Position encodes the assignment, so traces stay short and static.
- **Dock** for **unassigned** lights runs along the bottom, just below the connected
  lights.
- A **settings gear in a corner** opens a **separate window** (not a panel).

---

## Live state on the board

The diagram doubles as the at-a-glance monitor:

- **Lights and inputs** carry the tally **state colours** — live (red), preview (green),
  idle (a light, unlit grey) — plus the **setup colour** for unassigned devices, and a
  **greyed** look when disconnected. These are the *UI* colours; they intentionally differ
  from the physical device LEDs (see "UI vs. device colours" below).
- **Traces** show program *flow* in **blue**: a trace lights up when its input is live and
  reaching the lights; idle traces stay debossed.
- When an **override** is active (once one is configured — e.g. OBS off the ATEM scene),
  its trace into the gate goes blue, the gate visibly cuts, the input traces fall dark, and
  every light drops to idle — the single pinch-point makes the global block obvious.
- When the **source itself is disconnected** (no ATEM), the inputs grey out and their
  traces fall dead, but the **board keeps its layout** with a clear "source disconnected"
  indicator — you still see your whole rig.

---

## Interaction — the canvas is interactive, not read-only

Configuration of **lights and inputs happens here, on the canvas**, never in settings:

- **Assign** a device by clicking the light to open a **picker popover** that lists the
  inputs (by their source labels), with the current one marked; pick one and the light
  moves into that input's column, trace and all. The popover also offers **unassign** and
  **flash** (below). *Not* drag-and-drop.
- **Unassigned** connected devices sit in the dock in the setup colour; clicking one opens
  the same picker to wire it into a column.
- **Flash-to-identify** lives in that popover (a flash action): it blinks the light
  (IDENTIFY) so the operator can find the physical unit. Housing it here is why a plain
  click opens the popover rather than assigning directly. Since lights have no names (just
  a MAC tail), flashing is the only reliable way to tell apart lights that share an input.
- Input **labels come from the source** (per `GOALS.md`), so they aren't edited here.

---

## Settings (separate window)

Opened by the corner gear. It does **not** handle device-to-input assignment — that's
the canvas.

| Belongs on the **canvas** | Belongs in **settings** |
|---|---|
| Assigning lights to inputs | Defining the source (ATEM IP) |
| Flash-to-identify | Global / app preferences |
| Live tally state | — |

The **content and structure below are settled**. The **visual execution is now locked** —
prototyped and built at `app/src/routes/settings/+page.svelte` (see "Execution" below).

### Content — the full v1 settings list

Three groups, in this order:

**Source**
- **ATEM IP** — a text field (mono, per the typography rules). This is the only setting
  that exists in the schema today (`setSource` → `Source { ip, connection }` in
  `app/sidecar/src/ipc.ts`).
- **Scan network** — a button beside the field that sweeps the local subnet for ATEMs.
  Mirrors the working `tools/atem-probe` sweep: there's no ATEM broadcast, so it
  brute-force probes every host on each local /24 with the real handshake (~20s, runs
  async). Each hit returns `{ ip, product }` (e.g. `192.168.10.240 · ATEM Mini Pro`).
  Results show **inline** as a single-select list; picking one **fills the IP field**
  (it does *not* connect — see Behaviour). Manual entry is the primary path; scan is the
  assistive secondary one.
- **OBS override** — shown but **greyed / "Coming soon"**. Designed-for, built-later
  (the program-gate is in the schema from v1; only the OBS override *source* is deferred —
  see `GOALS.md`).

**General**
- **Launch on system startup** — toggle. Serves the "set up once, forget during the
  show" north star.
- **Restart TallyBot Engine** — a recovery button (reconnect switcher + devices if
  something gets stuck). User-facing wording is **"TallyBot Engine"**, never "sidecar".

**About**
- App **version**, **protocol version** (`CURRENT` / `MIN_SUPPORTED` from
  `app/sidecar/src/protocol.ts`) — mono values.
- The **same-subnet limitation** explainer.
- **Documentation / GitHub / license** links (this is open-source).


### Behaviour decisions

- **Save starts the connection.** There are **no connect / disconnect / forget buttons**
  in settings — saving commits the IP and the engine begins connecting. **Reconnect lives
  on the board's `SourceChip`**, not here.
- **Scan fills, doesn't connect.** Picking a scanned switcher only populates the IP field;
  `Save` is still what connects. (This differs from the probe, which connects on click.)
- **Scan states to handle:** idle (field + button only) · scanning (spinner in button +
  status line, button disabled, "~20s" hint) · results (inline select list, "found N —
  select one") · none/failed ("no switchers found on the local subnet").

### Execution (locked)

Built at `app/src/routes/settings/+page.svelte` — a flat **shadcn-svelte** (Luma) surface,
*not* the neumorphic board language (standard interfaces stay flat). A **single grouped,
scrollable pane**: the three groups stacked as bordered cards (Source / General / About) on
an off-white page, Inter throughout, IBM Plex Mono for the ATEM IP and the version values.

- **One shared, dirty-gated `Save` in a sticky footer** — *not* a per-field/per-group Save,
  so it scales as more savable settings arrive (e.g. OBS) without each growing its own
  button. Setting *values* (IP, launch-on-startup, future OBS) are **pending until Save**;
  `Cancel` reverts. The footer reads "Unsaved changes · Cancel · Save" when dirty, "All
  changes saved" when clean. Actions stay immediate (Scan-pick fills the field, Restart,
  links). Save commits all pending values and starts the connection if the IP changed.
- **Scan** results render inline as a hand-rolled single-select list (`ip · product` rows);
  picking fills the field as a pending change. Invalid IP shows an inline error and keeps
  `Save` disabled.
- **Polish:** chrome text is `user-select: none` (inputs opt back in); `cursor: pointer`
  was added to the shadcn `Button`/`Switch` base (Tailwind v4 drops it by default).
- shadcn components live under `app/src/lib/components/ui/`: `button`, `input`, `label`,
  `switch`, `separator`, `badge` (the scan list is bespoke, not `radio-group`).

### Deliberately left out of v1 (considered, deferred)

Recorded so a redesign doesn't re-litigate them. All were weighed and cut for v1; several
could return later:

- **No dark mode / theme toggle** — explicitly cut. Ensure none ships.
- **Network ports** (TCP 7000 / UDP 7001) — internal implementation detail, never
  surfaced.
- **Tally behaviour** — default brightness for new devices, show-preview-vs-live-only.
- **App lifecycle** beyond startup — close-to-tray, prevent host-PC sleep, confirm-quit,
  always-on-top.
- **Notifications** — firmware-outdated warning, device-disconnect alert.
- **Advanced** — network-interface selection, fault-debounce window, heartbeat/offline
  timeout, open config/log location, reset to defaults, export/import config.

---

## Canvas behaviour

- **No panning or zooming** — the diagram stays put.
- **No wrapping** where it would break the diagram (the input row, the gate, the columns
  stay intact).
- When content exceeds the window, use **scrollable overflow** rather than reflowing.

---

## Visual language

### Surface language — neumorphism

The entire canvas is built on a **neumorphic surface language**: components appear to
be moulded from the same material as the board itself, either extruded up from it or
pressed into it. This is the governing rendering style for all bespoke canvas elements
(not shadcn UI, which stays flat/standard).

**How it works** — raised and recessed elements are defined by **two shadows**: a bright
highlight on the top-left and a deeper shadow on the bottom-right (or inverted for inset
elements), both derived from the board's background colour. No harsh outlines; the
surface implies the shape.

The key constraint: the **board background must be off-white**, not pure white — pure
white eliminates the highlight shadow and kills the effect. Shadow colours are tonal
siblings of the background, not arbitrary greys.

Which specific elements are raised vs. inset, and by how much, is decided component by
component as they are built.

### Colour rules

- **White/off-white theme** — the board surface is off-white, not pure white (neumorphism
  requires it for shadow contrast).
- **Traces** — at rest, a **debossed line** engraved into the board with a thin **blue
  accent along the edge**. A trace turns **solid/glowing blue when its path is active**.
- **Blue means activity, not state.** Blue marks an energised signal path (and accents
  the source); it is *not* a tally colour. The tally **state colours — live (red),
  preview (green), idle (unlit grey) — live on the lights and inputs**, not the traces.
- **Disconnected** is shown **greyed / dimmed** (drained of colour) rather than any blue
  — blue is reserved for activity.
- **Two-blue activity system** (see Palette section below).

#### UI vs. device colours

**The on-screen colours are not the physical LED colours.** The device LEDs are defined in
[`ARCHITECTURE.md`](ARCHITECTURE.md); the UI mimics a real ATEM switch *face*, so it tunes
for skeuomorphic realism and for the off-white board, not for an LED-exact match. Two
states diverge deliberately:

| State | Device LED (ARCHITECTURE) | UI (this board) | Why they differ |
|---|---|---|---|
| Live | red `255,0,0` | red | same |
| Preview | green `0,255,0` | green | same |
| Idle | **dim white** `30,30,30` | **light grey** | a dim-white key wouldn't read on an off-white board; grey is the switch's "unlit but present" key |
| Disconnected | **steady blue** `0,0,255` | **greyed / drained** | in the UI, **blue is reserved for activity** (traces, source) — so a disconnect can't borrow it |
| Fault | blue `0,0,255` *flashing* | — | device-only signal; no board treatment yet |

The through-line: on the *device*, blue is a fallback/error colour; in the *UI*, blue is
the live signal path. They must never be conflated — hence disconnection greys out here
instead of going blue.

---

## Palette & typography

Standard interfaces (settings, the picker popover) are built with **shadcn-svelte** (Luma
style, Lucide icons) on Tailwind v4; the canvas itself is bespoke. Tokens live in
`app/src/routes/layout.css`.

- **Type** — **Inter** for all UI; **IBM Plex Mono** (`font-mono`) for fixed-width
  technical identifiers: the **MAC tails** on lights and the **ATEM IP** in settings.
- **Neutrals** — a cool **zinc** grey ramp on an off-white background, kept narrow so the
  status colours read true.
- **Two-blue activity system** — blue is split into a calm UI accent and a hot signal:
  - `--primary` **Azure** `oklch(0.585 0.195 250)` — buttons, focus ring (`--ring`), the
    source chip. Behaves as a normal accent; white text stays legible on it.
  - `--signal` **Cyan** `oklch(0.7 0.165 209)` — the energised-signal colour for active
    traces and the override→gate link, exposed as the `signal` utility colour. This is the
    *colour* only; the trace's visual treatment is still open (see below).
- **Tally state colours** (live red / preview green / idle grey) *approximate* the device
  LED values in [`ARCHITECTURE.md`](ARCHITECTURE.md) but don't match them — idle is a light
  grey here (the LED is dim white) and **disconnected** greys out (the LED goes blue). See
  "UI vs. device colours" above for the full mapping and rationale. Tokens live in
  `layout.css`: `--live`, `--preview`, `--idle`.

---

## To refine

- **Neumorphic shadow values** — exact `box-shadow` recipe (offset, blur, spread,
  opacity) decided component by component as they're built.
- **Trace rendering** — the inset-groove-at-rest and active look (inner-edge accent,
  glow spread/blur, whether it pulses or is static). Colour is settled (`--signal`);
  exact form is not. A CSS `inset` shadow + a thin inner-edge pseudo-element is a
  candidate; a thin SVG overlay is another.
- Whether **preview** (not just live) lights its trace, or only live does.
- **Board background token** — the exact off-white oklch value. Needs to be warm
  enough for neumorphic shadow contrast but still read as "white" to the eye.
- A **reference image** of a real ATEM Mini + tally puck to anchor the skeuomorphic
  detail level (how much realism, where it stops).
- **Staging** in the dock — ordering of newly-discovered lights; whether the puck
  animates in.
- **Dot-grid spacing** and **minimum window size**.

---

## Design todo

### Primitives (locked)

- [x] **SourceChip** — neumorphic ATEM source chip; connected/disconnected states
- [x] **InputKey** — skeuomorphic ATEM input button; live/preview/idle states
- [x] **TallyLightPcb** — ESP32-C3 PCB unit; all six LED states (live, preview, idle, setup, disconnected, fault)

### Blocking — must be designed before layout assembly

- [ ] **Board background token** — exact off-white `oklch(…)` value; warm enough for neumorphic shadow contrast, still reads as white
- [ ] **Program-output gate** — visual form of the converge-then-diverge "X" in the gutter between inputs and lights; override-source wire-in (hidden in v1)
- [x] **Trace rendering** — debossed-at-rest recipe; active glow form (CSS inset + pseudo-element vs SVG overlay); whether preview lights the trace or only live does

### Interaction — can overlap with layout build

- [x] **Assign / flash picker popover** — opens on plain click of any light; lists inputs with current marked; unassign + flash actions; shadcn-based

### Independent — doesn't block layout

- [x] **Settings window** — built at `app/src/routes/settings/+page.svelte`: Source /
  General / About single grouped pane, scan feature, shared footer Save-starts-connection
  (see "Settings → Execution" above). Still to wire: the real Tauri window + corner-gear
  entry point and live IPC (currently mocked)
- [ ] **Dock** — unassigned-lights tray at the bottom; re-prototype with TallyLightPcb (prior sketch used the rejected puck)

### Minor — resolve alongside build

- [ ] Dot-grid spacing and minimum window size
- [ ] Dock staging order and whether a newly-discovered light animates in

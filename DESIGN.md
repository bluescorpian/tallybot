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
- A **settings gear** lives in the titlebar (see "App chrome" below) and opens the
  **settings drawer** — a panel that slides out from the right, *over* the board (which
  stays visible behind it).

---

## App chrome (window frame)

The board fills the window — the chrome around it is deliberately thin, because the board
*is* the monitor (the `SourceChip` carries source status, the dock the unassigned lights,
the keys/lights the tally). So there is no header status summary, no status bar, and no
counts duplicating the canvas.

- **Custom frameless titlebar** (`$lib/components/chrome/TitleBar.svelte`). The native OS
  titlebar is off (`decorations: false` in `tauri.conf.json`); our own bar replaces it: the
  **TallyBot wordmark** on the left, and on the right the **settings gear** followed by the
  **window controls** (minimize · maximize/restore · close). The bar is the drag region
  (`data-tauri-drag-region`); the button cluster is excluded so it stays clickable. Window
  ops go through `@tauri-apps/api/window`, guarded by an `isTauri` check so the bar still
  renders (and the buttons no-op) under `pnpm dev` in a plain browser.
- **The titlebar stays on top of everything**, including the settings drawer: the drawer's
  overlay and panel are anchored *below* the titlebar (a shared `--titlebar-h` token), so the
  window controls are never covered or dimmed.
- **The board fills the whole area** beneath the titlebar with only a small uniform margin gap.
- **A subtle credit** (`Credit.svelte`) — "Made with ♥ by Harry" — is **absolutely
  positioned and non-interactive**, floating low-emphasis over the board's bottom margin so
  it doesn't claim a row; the board fills the stage behind it. Not a bordered status strip.
- The titlebar and credit use the **flat UI language** (zinc / Inter / shadcn tokens), not
  the neumorphic board surface.

**Known v1 limitation — no edge-resize on Wayland.** `decorations: false` drops the native
resize frame on every platform, and `startResizeDragging` is unreliable on Wayland/WebKitGTK
on the dev box, so v1 ships without custom resize handles: rely on the default window size
and the maximize button. (Add custom handles later if needed.) The window controls also sit
on the **right** (Windows/Linux convention); macOS would expect them on the left — a later
platform branch, not a v1 concern since the target is Linux.

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
- **Per-device brightness** sits in the same popover, between the MAC header and the
  assign list (so it's reachable for docked lights too). A flat, rounded **amber bar**
  (the warm `--brightness` token — its own "light level" axis, never a tally/signal
  colour) that **animates smoothly** across **10 levels** (`0` = off → LED dark), flanked
  by **−/+** buttons, with the exact level read out in the middle of the bar. The UI maps
  the 0–10 level to the protocol's 0–255 brightness byte (`BrightnessBar.svelte`; level 5
  ≈ the default byte 128).
- Input **labels come from the source** (per `GOALS.md`), so they aren't edited here.

---

## Settings (slide-out drawer)

A **right-side slide-out drawer** (shadcn `Sheet`) over the board — *not* a separate OS
window. Opened by the corner gear, and by the `SourceChip`'s "Set up your ATEM →" link
(which lands on **Source**). It does **not** handle device-to-input assignment — that's the
canvas.

**Why a drawer (decided 2026-06-04):** keeping the board visible behind the panel preserves
context — you type the ATEM IP, hit Save, and watch the `SourceChip` go connecting →
connected and the lights come alive, without leaving the screen (a full-page/separate window
throws that live feedback away). It matches the flat shadcn language settings already use and
re-hosts the built content rather than rebuilding it. The current list is a tidy handful of
groups, which a scrolling drawer handles well; **if it later outgrows comfortable scrolling,
promote the group headers into an in-sheet nav rail** (additive, not a rewrite).

| Belongs on the **canvas** | Belongs in **settings** |
|---|---|
| Assigning lights to inputs | Defining the source (ATEM IP) |
| Flash-to-identify | Global / app preferences |
| Per-device brightness | — |
| Live tally state | — |

The **content and structure below are settled** and the grouped-card content is **built**
(as `$lib/components/settings/SettingsPanel.svelte`, hosted by the drawer
`SettingsSheet.svelte` — see "Execution" below).

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
- **Drawer dismissal protects unsaved edits.** There is **no X** in the header — `Cancel`
  and the backdrop are the exits. `Cancel` is **always enabled** and means *discard & close*
  (revert pending values, then dismiss). When **clean**, clicking the backdrop / pressing
  Escape closes the drawer (nothing to lose); when **dirty**, both are **blocked** so a stray
  click can't silently throw away edits — you leave deliberately via `Cancel` (discard) or
  `Save` (commit).

### Execution

The settings **content is locked** — a flat **shadcn-svelte** (Luma) surface, *not* the
neumorphic board language (standard interfaces stay flat): the three groups stacked as
bordered cards (Source / General / About), Inter throughout, IBM Plex Mono for the ATEM IP
and the version values, over the shared dirty-gated footer.

**Shell — a right-side slide-out drawer.** The cards + footer live in
`SettingsPanel.svelte`, hosted by `SettingsSheet.svelte` — a shadcn **`Sheet`** that slides in
from the right over the board (board visible behind), ~400px wide, the group cards scrolling
within it; the sheet's own header carries a gear icon + the "Settings" title. This **replaces**
the earlier separate-window plan. **Dismissal** has no X button — `Cancel` (always enabled =
*discard & close*) and the backdrop are the exits, and backdrop-click / Escape are **blocked
while there are unsaved edits** so a stray click can't silently discard them.

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
- **Neutrals** — a cool **zinc** grey ramp for the shadcn UI, kept narrow so the status
  colours read true.
- **Board canvas surface** — the bespoke board is a **warm off-white "greige"**
  (`--board: oklch(0.966 0.004 74)`), deliberately warmer than the cool zinc UI so the
  neumorphic shadows have contrast without reading cold. Its recessed surfaces (slot
  lanes, dock) are `color-mix(--board, black N%)` so they track the hue, and a tonal
  **dot-grid** (`--board-dot`, hue-matched, low-alpha) overlays it. Retune the whole
  board from the `--board` / `--board-dot-*` block in `layout.css`.
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
- A **reference image** of a real ATEM Mini + tally puck to anchor the skeuomorphic
  detail level (how much realism, where it stops).
- **Staging** in the dock — ordering of newly-discovered lights; whether the puck
  animates in.
- **Minimum window size** — the board fills the window width with the content
  left-aligned (extra width becomes dot-grid margin); the floor is still TBD.

---

## Design todo

### Primitives (locked)

- [x] **SourceChip** — neumorphic ATEM source chip. Four lifecycle states off the
  schema (`Source.connection` × `ip`): **connected** (lit LED + IP in mono),
  **connecting** / **disconnected** (status dot becomes a neutral spinner — the engine
  auto-reconnects, so "Connecting…" / "Reconnecting…"), and **unconfigured** (no IP yet
  → the status area is a muted "Set up your ATEM →" link into Settings, using the shared
  `ArrowLink` affordance: animated colour-lighten + arrow nudge mark it as a link). The
  three-valued connection + the `ip === null` "never configured" case are kept distinct in
  `boardState.ts` (not collapsed to a boolean).
- [x] **InputKey** — skeuomorphic ATEM input button; live/preview/idle states
- [x] **TallyLightPcb** — ESP32-C3 PCB unit; all six LED states (live, preview, idle, setup, disconnected, fault)

### Blocking — must be designed before layout assembly

- [x] **Board background token** — warm off-white "greige" `--board: oklch(0.966 0.004 74)`; the board surfaces (lanes/dock/gate) derive from it via `color-mix`, and a tonal dot-grid (`--board-dot-*`: 32px pitch, 1.5px radius, 0.12 alpha, hue-matched) sits on top. All in `layout.css` under one block.
- [x] **Program-output gate** — built as `ProgramGate.svelte`: a circular node on the trace path, trace-coloured (grey `rest` / cyan `hot` / muted-red `cut` / dimmed `inert`). The override-source wire-in into the gate's right exists in the board but is shown only when an override is active (v1 has none).
- [x] **Trace rendering** — debossed-at-rest recipe; active glow form (CSS inset + pseudo-element vs SVG overlay); whether preview lights the trace or only live does

### Interaction — can overlap with layout build

- [x] **Assign / flash picker popover** — opens on plain click of any light; lists inputs with current marked; unassign + flash actions; shadcn-based
- [x] **Per-device brightness bar** — built as `BrightnessBar.svelte` in the picker popover (between the MAC header and the assign list): a flat rounded amber bar animating across 10 levels (0 = off), −/+ buttons, level read out centred; maps 0–10 → the 0–255 protocol byte. Mock-wired (`onbrightness`); live `setBrightness` IPC lands with Phase 5.

### Independent — doesn't block layout

- [x] **Settings content** — built as `$lib/components/settings/SettingsPanel.svelte`: Source /
  General / About grouped cards, scan feature, shared footer Save-starts-connection
  (see "Settings → Execution" above).
- [x] **Settings drawer + entry points** — built. The locked content is extracted into
  `$lib/components/settings/SettingsPanel.svelte` (cards + footer + form logic) and hosted by
  `SettingsSheet.svelte` (a right-side shadcn `Sheet` over the board, ~400px). The **corner
  gear** on the titlebar and the `SourceChip` "Set up your ATEM →" `onsetup` both open the
  drawer. Mock first — `Save` calls `onsave(ip)`, which nudges the mock source mode so the
  `SourceChip` animates connecting → connected behind the open panel; **live IPC** (real
  `setSource` / scan / restart) lands with Phase 5.
- [x] **Dock** — built as `BoardDock.svelte`: a recessed bottom tray of the unassigned
  lights (`TallyLightPcb` in the setup colour) with an "Unassigned" header + count; clicking
  one opens the same picker to wire it into a column.

### Minor — resolve alongside build

- [ ] Minimum window size (dot-grid spacing is locked: 32px pitch in `layout.css`)
- [ ] Dock staging order and whether a newly-discovered light animates in

### Layout assembly (built)

The board is assembled as a locked, presentational `Board.svelte` (in
`$lib/components/board/`) composed of the locked primitives — `SourceChip`, `InputKey`,
`Trace`, `ProgramGate`, `TallyLightPcb`/`LightPicker`, `BoardDock` — over the computed
trace geometry. It is **decoupled from the backend**: it takes a small view-model
(`types.ts`: `BoardInput` / `BoardLight`, already resolved to primitive states), and the
app-layer mapper `$lib/boardState.ts` (`toBoardProps`) turns the sidecar `AppState`
(`app/sidecar/src/ipc.ts`, imported type-only via `$ipc`) into it. That mapper is the
single home for the **state interpretation**:

| Source of truth (`ipc.ts`) | UI result | Notes |
|---|---|---|
| `Input.tally = unknown` | InputKey **idle** | a powered-off ATEM is just an unlit button — no separate "unknown" look on the key |
| assigned light, its input `tally = unknown` | TallyLight **fault** (flashing blue) | a connected light must not be shown a confident idle when the source can't be trusted |
| `Device.state = offline` | TallyLight **offline** (steady blue) | device-local; lost the sidecar |
| `Device.state = unassigned` | TallyLight **setup** (in the dock) | |
| `programGate.active` (override) | every assigned light **idle**, gate **cut**, diverge traces dark | the single pinch-point makes the global block obvious |
| `source.connection ≠ connected`, inputs **retained** | gate **inert**, traces dimmed, keys idle | a *remembered* source kept its layout; the disconnect indicator is the `SourceChip` |
| no source + **empty** inputs (first run / connecting) | **scaffold**: a default ATEM-Mini **4 idle keys** | the board never collapses; the chip ("Set up your ATEM →" / "Connecting…") carries the reason |
| `connection = connected` but **empty** inputs | **"No inputs detected"** notice (no keys) | anomaly (odd model / lib quirk) — fake keys would lie, so we say it plainly |
| any state with **no real inputs** | every light drops to the **dock**, flash-but-no-assign | viewable + flashable (online); the picker swaps its assign list for "connect a source to assign" |

**Empty-inputs handling is gated on `source.connection`, not `inputs.length`** (the two empty
cases above are genuinely different). The no-source scaffold + dock-routing live in the mapper,
so `Board` only meets truly-empty inputs in the anomaly case (its small, defensive empty
branch). **Assignments are global, not per-source** (`store.ts`: one `sourceIp` + a flat
MAC→`{inputId, brightness}` map), so a light's wiring survives source changes; reworking that to
per-source would be a separate change.

The assembled board lives on the **main route** (`app/src/routes/+page.svelte`), currently
driven by **mock data + dev toggles** (a 5-way source-mode select · override) so the whole
state matrix is visible without a running sidecar. **Phase 5** swaps the mock for the real
Tauri/IPC snapshot stream and drops the toggles.

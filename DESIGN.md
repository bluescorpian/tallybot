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

- **Lights and inputs** carry the tally **state colours** — live (red), preview (yellow),
  idle (green) — plus the **setup colour** for unassigned devices, and a **greyed** look
  when disconnected.
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

Opened by the corner gear. Scope:

- **Define the source** — the ATEM connection (IP). v1 is ATEM-only; other sources are a
  deferred addition (see `GOALS.md`).
- Other global / app-level settings.

It does **not** handle device-to-input assignment — that's the canvas.

| Belongs on the **canvas** | Belongs in **settings** |
|---|---|
| Assigning lights to inputs | Defining the source (ATEM IP) |
| Flash-to-identify | Global / app preferences |
| Live tally state | — |

---

## Canvas behaviour

- **No panning or zooming** — the diagram stays put.
- **No wrapping** where it would break the diagram (the input row, the gate, the columns
  stay intact).
- When content exceeds the window, use **scrollable overflow** rather than reflowing.

---

## Visual language

- **White theme** — light background, clean and modern.
- **Subtle dot-grid** board texture.
- **Skeuomorphic components** — the source looks like an ATEM Mini, inputs like its
  physical buttons, lights like real tally units. Realistic, but kept clean and modern.
- **Traces** — at rest, a **debossed line** engraved into the board with a thin **blue
  accent along the edge**. A trace turns **solid/glowing blue when its path is active**: an
  input→light trace when that light is **live**, and the override→gate trace when the
  **override is active**.
- **Blue means activity, not state.** Blue marks an energised signal path (and accents the
  source); it is *not* a tally colour. The tally **state colours — live (red), preview
  (yellow), idle (green) — live on the lights and inputs**, not the traces.
- **Disconnected** is shown **greyed / dimmed** in the UI (drained of colour, since it
  isn't reporting) rather than the LED's literal blue — blue is reserved for activity.

---

## To refine

- Whether **preview** (not just live) also lights its trace, or only live does.
- A **skeuomorphism reference** to anchor the look (a real ATEM / tally photo to match).
- **Staging** details in the dock (ordering, how a newly-discovered light appears).
- Exact **palette** values, typography, dot-grid spacing, minimum window size.

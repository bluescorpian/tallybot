# TallyBot — Goals & Product Decisions

This file is the **north star** for what the system should *do* and *feel like*. It holds
the product intent and the decisions behind it. Where `docs/architecture.md` says *how* the
system works, this file says *what we're
building and why* — and it is the document a contributor (or agent) should read before
designing the IPC schema, the settings surface, or the UI, so the patterns they create
match the intended model.

Decisions here are the source of truth for product/UX intent. Keep `docs/architecture.md`
consistent with it.

---

## North star

A wireless camera tally system that a single operator sets up once and then forgets for
the rest of the show. Camera operators glance at a light and instantly know if they're
live, on preview, or idle. Setup is zero-config on the network and friendly to
non-technical users; runtime is reliable on unknown networks and demands no interaction
during a production.

*(Derived from `docs/architecture.md`; correct if the framing is off.)*

---

## Positioning — the differentiator

The primary differentiator over every existing open-source tally project is a **"buy the
hardware, install the app, you're done"** experience. No soldering (the ESP32-C3 SuperMini
V2 has an onboard WS2812 LED — it is a complete tally light as shipped), no Arduino IDE, no
hardcoded IPs, no terminal commands. A non-technical church volunteer should be able to
provision a tally light and assign it to a camera in under five minutes.

No competitor has a native desktop app with bundled provisioning. That gap is what the
onboarding and transport work on the roadmap fills — see
[`docs/milestones/roadmap.md`](milestones/roadmap.md).

---

## Core concepts (the vocabulary the schema should mirror)

The system is built around a small, layered model. The IPC schema, the persisted state,
and the UI should all use these same nouns.

- **Source** — what produces *inputs* and reports which are live/preview. **v1 hardcodes
  the ATEM Mini as the source** — the schema is ATEM-shaped, not a generic source
  collection. Other sources (e.g. **OBS**, when the user switches cameras in OBS instead
  of on the ATEM) are a **deferred refactor**: adding them will reshape the contract, and
  that cost is accepted in favour of a simpler v1.

- **Input** — the unit a tally **device is bound to** (e.g. ATEM input 1). An input has
  an id and a **label that comes from the source** (the ATEM's own configured input
  names). Devices are assigned to inputs — there is **no separate "camera" entity**.

- **Program / Preview** — the live and preview state, derived from the source. An input
  is *live* when it's on program output, *preview* when on preview, otherwise *idle*.

- **Override (program gating)** — an optional layer that can **block the program
  output**, forcing every input to idle regardless of what the source reports. Its first
  use is the OBS connector: if OBS's active scene does not contain the ATEM source,
  program is blocked. The **program-gate stays in the schema from v1** (always inactive
  until an override source is configured), so adding OBS *as an override* is cheap — it's
  only OBS *as an input source* that needs the deferred refactor above.

- **Device** — a physical tally light, **identified by MAC, with no user-given name**,
  assigned to one input. Several devices may share one input (e.g. front and back lights
  on one camera); they're told apart by a short **MAC tail** and by **flashing** them
  (the locate strobe).

- **Device states** — a device is *assigned* (shows its input's tally), *unassigned*
  (connected but not yet bound to an input), or *offline* (known but not currently
  connected). Unassigned connected devices are surfaced in the UI and shown with a
  distinct **setup colour** on the LED so they're visibly alive and clearly need
  configuring.

The engine pipeline this implies: **source → per-input program/preview → override(s) →
per-device colour.**

---

## Decisions made

These are settled product decisions; they have wide impact on the schema and UX.

1. **Built around inputs, not cameras.** A device maps to a source *input*. No separate
   named-camera entity.
2. **v1 hardcodes the ATEM as the source.** The schema is ATEM-shaped for now; a general
   multi-source model (OBS or others as a switcher) is a **deferred refactor** that will
   reshape the contract later — accepted as the simpler v1. *(The program-gate/override is
   the exception — it stays in the schema from v1, so adding OBS as an override is cheap;
   adding it as a source is the refactor.)*
3. **Setup is flash-to-identify.** To locate the physical light behind an on-screen
   device, the operator flashes it (the sidecar streams a white/off burst). With no device
   names, this is also the only way to tell apart lights that share an input.
4. **Input names come from the source.** TallyBot mirrors the ATEM's own input labels
   rather than asking the user to name everything.
5. **Unassigned devices get a distinct setup colour** (white, slow breathe — see
   [`docs/led.md`](led.md) state 5) and appear in the UI for assignment, rather than
   staying dark or masquerading as idle.
6. **Devices have no user names.** A light is identified by its MAC (a short tail in the
   UI) plus flash-to-identify — there is no nickname field in the schema.
7. **Target platforms are Linux and Windows.** **Linux** is the development platform;
   **Windows** is the platform for the official released build. **macOS is out of scope** —
   there is no build, test, or publish path planned for it. This shapes platform-specific
   work (e.g. USB flashing/serial in the [onboarding milestone](milestones/v1.2-zero-friction-onboarding.md)
   is validated on Linux first, then Windows).

---

## UX principles

- **Set up once, forget during the show.** No interaction should be required while live.
- **Legible at a glance.** State must be unambiguous from across a room.
- **Zero-config on the network.** Devices and the app find each other; no IP typing for
  devices.
- **Friendly to non-technical users.** Prefer physical cues (flashing a light) over
  identifiers; surface only a short **MAC tail** where an identifier is unavoidable, and
  keep the rest of the plumbing hidden.
- **Reliable on unknown networks.** Favour simplicity and graceful reconnection over
  features. *(See [`docs/architecture.md`](architecture.md) for the same-subnet limitation.)*

---

## Non-goals & deferred

- **Deferred — needs a refactor:** non-ATEM **input** sources (OBS or others as a
  switcher). v1 hardcodes the ATEM, and adding a source will reshape the schema.
- **Designed for, built later:** the OBS program-gating **override**. The program-gate is
  already in the schema; only the OBS-side override source is deferred.
- **Out of scope for v1:** per-device colour/appearance customisation, multi-switcher
  running simultaneously, anything crossing subnet/router/VLAN boundaries, **macOS support**
  (Linux + Windows only — see decision 7).

---

## Still to decide

- For OBS specifically: the **override** path is the modelled, cheap one (the program-gate
  is already in the schema); OBS as an **input source** would need the deferred source
  refactor. Which to build first isn't locked.

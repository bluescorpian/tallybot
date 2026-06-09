# docs/spec/

Pre-implementation design documents for individual features. A spec is written before
coding starts; it closes when the feature ships (move to `docs/archive/` or delete).

## What goes here

- Detailed designs for a single feature or subsystem: decisions made, alternatives
  rejected, open questions, acceptance criteria.
- Anything too narrow for `architecture.md` (the protocol / structural source of truth)
  but too detailed to live in a milestone worklist.

## What goes elsewhere

| Content | Home |
|---------|------|
| Protocol spec, network topology, IPC schema | [`docs/architecture.md`](../architecture.md) |
| Product intent, user-facing decisions | [`docs/goals.md`](../goals.md) |
| UI visual/interaction design | [`docs/design.md`](../design.md) |
| Milestone scope + acceptance criteria | [`docs/milestones/`](../milestones/) |
| LED palette and state rules | [`docs/led.md`](../led.md) |
| In-progress runbooks / troubleshooting | root of `docs/` |

## Naming

`<feature-slug>.md` — e.g. `usb-flashing.md`, `esp-now-bridge.md`,
`serial-provisioning.md`. One file per feature; cross-link to the relevant milestone doc.

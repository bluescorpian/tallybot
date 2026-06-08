# TallyBot — Roadmap

Deferred work: items out of scope for v1, tracked here for when the baseline is solid.
Acceptance criteria for each item are defined when (and if) it's scheduled.

---

## Firmware / device

- **OTA updates** — flash new firmware over WiFi from the app, without a cable.

---

## App / sidecar

- **Web UI** — a browser-accessible view served by the sidecar, readable from other
  devices on the network (phones, tablets at the mixing desk).

- **In-app device diagnostics** — per-device health panel (RSSI, IP, uptime, reconnect
  count, firmware version), fed by a new device→server diagnostic frame. Tracked as an
  active item in [`v1.1-production-hardening.md`](v1.1-production-hardening.md).

- **Per-device colour customisation** — let the operator choose custom colours per device
  or input, beyond the fixed red/green/white palette. (Per-device *brightness* is already
  v1.)

---

## Multi-source / integrations

- **Multi-switcher** — connect more than one ATEM simultaneously; each device is still
  assigned to one input on one switcher.

- **OBS integration (obs-websocket)** — two paths, one cheap, one a refactor:

  - **Override / program-gate** (cheap — already modelled in the IPC schema): connect to
    OBS via obs-websocket and monitor the active scene. When OBS is on a scene that does
    *not* contain the ATEM feed, the program-gate forces every device to Idle. When OBS
    is back on the ATEM scene, normal tally resumes. The program-gate is already present
    and inactive in the schema; wiring the OBS side is purely additive.

  - **OBS as an input source** (deferred refactor): treat OBS as the switcher — cameras
    are OBS scenes, and per-scene tally drives the lights instead of ATEM inputs. This
    reshapes the IPC schema (`source` becomes polymorphic) and is a larger change.
    The override path above does *not* require this refactor.

- **Non-ATEM switchers** — a general multi-source model where other switchers (Tricaster,
  vMix, Roland) can drive tally. Requires the same source-polymorphism refactor as OBS
  as an input source.

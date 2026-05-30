# TallyBot ATEM Probe

A small, standalone field-test tool: connect to a real ATEM (e.g. a Mini Pro) and
watch its **program / preview** state update live in your browser. Use it to confirm,
on real hardware, that TallyBot can talk to a switcher before the full app is ready.

It uses the sidecar's **real `AtemSource` adapter** (vendored into `src/atem-source.ts`)
— the same code production runs — so if the lights here track the switcher, the
production read-path works against that hardware too.

This folder is **fully self-contained**: copy it (or a zip of it) anywhere and run — it
needs nothing else from the repo.

## Quick start (Windows)

1. **Copy this folder (or its zip) onto the machine** and unzip it.
2. **Double-click `run.cmd`**.

That's it. On first run it will, automatically:

- **install Node.js if it's missing** (via winget, falling back to the official
  installer — accept the Windows security/UAC prompt if it appears),
- install the tool's dependencies (about a minute),

then a console window opens — keep it open, it's your live log — and your browser opens
to **<http://127.0.0.1:4848>**.

> If the automatic Node.js install is blocked (e.g. winget unavailable and the UAC
> prompt declined), it opens <https://nodejs.org/> so you can install the **LTS**
> manually, then just double-click `run.cmd` again.

On macOS/Linux, run `./run.sh` instead (it expects Node already installed).

## Using it

1. Put this computer on the **same network/subnet** as the ATEM (the same-subnet limit
   is intentional — see `ARCHITECTURE.md`).
2. Enter the ATEM's IP address (find it in *ATEM Software Control → Preferences*, or
   click **Scan network** to sweep the local subnet for switchers) and hit **Connect**.
   The last IP is remembered for next time.
3. Push cameras to **program** and **preview** on the switcher. You should see:
   - the status pill turn **green (CONNECTED)** and the blue **heartbeat dot** flash on
     every update,
   - the large red **PROGRAM** and green **PREVIEW** tiles follow the switcher,
   - the input grid light up (red = on air, green = preview).

If that all tracks, TallyBot can read this switcher. 🎉

## Troubleshooting / observability

- The **System log** panel shows everything under the hood live — connection events,
  raw `stateChanged` paths, and errors — with a level filter.
- Everything is also written to **`tallybot-atem-probe.log`** in this folder, so you can
  review a session afterwards (or click **Download log file**).
- **Won't connect?** Check the IP, confirm both devices are on the same subnet, and
  watch the log — `atem-connection` retries automatically, so a wrong IP just sits in
  "CONNECTING…". A firewall prompt on first launch should be allowed.

## Packaging a zip to carry to another machine

From a dev machine (with Node), build a ready-to-run zip:

```bash
bash package.sh          # -> dist/tallybot-atem-probe.zip
```

The zip bundles the source **and** a production `node_modules`, so on the target it
needs no internet for dependencies — just unzip and double-click `run.cmd` (Node itself
is still auto-installed by `run.cmd` if missing). On NixOS, run it with `zip` available:
`nix shell nixpkgs#zip -c bash package.sh`.

## How it runs

There's no build step and no bundling — it runs straight from the TypeScript source via
Node (newer Node strips types automatically; `run.cmd` adds the
`--experimental-strip-types` flag when an older Node needs it). Running from source means
`atem-connection` and its files sit on disk in `node_modules` exactly as the library
expects, so nothing special is needed to make it work.

Useful scripts:

```bash
npm start        # run the probe (what run.cmd / run.sh call)
npm run typecheck
```

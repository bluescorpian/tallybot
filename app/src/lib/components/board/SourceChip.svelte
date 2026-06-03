<script lang="ts" module>
  /**
   * Source link lifecycle as the chip shows it:
   *   connected    — reachable; the status LED is lit, the IP is shown in mono.
   *   connecting    — first attempt after a source was saved; dot is a spinner.
   *   disconnected  — was reachable, now lost; the engine reconnects on its own,
   *                   so the dot is a spinner too ("Reconnecting…").
   *   unconfigured  — no source set yet (`ip === null`); the status area becomes
   *                   a "Set up your ATEM →" link into Settings.
   * `connecting` and `disconnected` look the same on purpose — both mean "the
   * system is actively trying", which is exactly what the spinner conveys.
   */
  export type SourceStatus =
    | "connected"
    | "connecting"
    | "disconnected"
    | "unconfigured";
</script>

<script lang="ts">
  // The source (ATEM) as a matte hardware chip — a milled "Wide Pill" module
  // that sits on the board. UIverse-derived neumorphism (Yaya12085, uiverse.io):
  // dark border + diagonal gradient + inset bevel + a two-tone drop shadow that
  // grounds it on the off-white board. The inputs are its pins (rendered by the
  // board, not here); traces connect later.
  import ArrowLink from "$lib/components/ArrowLink.svelte";

  interface Props {
    /** Connection lifecycle — drives the status dot + label. */
    status?: SourceStatus;
    /** Source IP, shown in mono when connected. */
    ip?: string;
    /** Invoked by the "Set up your ATEM →" link (unconfigured) → opens Settings. */
    onsetup?: () => void;
    class?: string;
  }

  let {
    status = "connected",
    ip = "",
    onsetup,
    class: className = "",
  }: Props = $props();

  // The dot is a spinner while the engine is working to reach the source.
  const spinning = $derived(status === "connecting" || status === "disconnected");
</script>

<div
  class="chip {className}"
  class:disconnected={status !== "connected"}
  class:setup={status === "unconfigured"}
>
  <img src="/bmd-logo.png" alt="Blackmagic Design" class="logo" />
  <span class="rule"></span>
  <div class="status">
    {#if status === "unconfigured"}
      <ArrowLink class="setup-link" onclick={() => onsetup?.()}>
        Set up your ATEM
      </ArrowLink>
    {:else}
      {#if spinning}
        <span class="spinner" aria-hidden="true"></span>
      {:else}
        <span class="led" aria-hidden="true"></span>
      {/if}
      {#if status === "connected" && ip}
        <span class="ip">{ip}</span>
      {:else}
        <span class="status-text">
          {status === "connected"
            ? "Connected"
            : status === "connecting"
              ? "Connecting…"
              : "Reconnecting…"}
        </span>
      {/if}
    {/if}
  </div>
</div>

<style>
  /* The pill body. The raised look is the dark border + top-left-lit gradient
     + inset bevel + the drop shadow (dark lower-right, white upper-left) lifts it
     off the off-white board. Tuned and locked in /preview. */
  .chip {
    width: min(300px, 100%);
    height: 60px;
    display: flex;
    align-items: center;
    padding: 0 20px;
    gap: 14px;

    border-radius: 9999px;
    border: 3px solid oklch(0.09 0.005 250);
    background: linear-gradient(
      145deg,
      oklch(31.274% 0.0077 264.496),
      oklch(0.135 0.013 252)
    );
    box-shadow:
      /* inset bevel: light top-left, dark bottom-right */
      inset 2px 2px 0 oklch(0.46 0.005 286),
      inset -2px -2px 0 oklch(0.1 0 0),
      /* drop shadow — grounds the chip on the board */
      6px 6px 11px oklch(0.12 0 0 / 0.55),
      -4px -4px 9px oklch(1 0 0 / 0.5);
  }

  .logo {
    height: 44px;
    width: auto;
    object-fit: contain;
    flex-shrink: 0;
  }

  .rule {
    width: 1px;
    height: 26px;
    background: oklch(1 0 0 / 0.1);
    flex-shrink: 0;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 9px;
    flex: 1;
    min-width: 0;
  }

  .led {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--primary);
    box-shadow: 0 0 7px 1px color-mix(in oklch, var(--primary), transparent 38%);
  }

  /* The status dot becomes a spinner while the engine is reaching the source —
     a neutral ring (no blue: that's reserved for live signal) with one bright
     head sweeping round, so "actively trying" reads at a glance. */
  .spinner {
    display: inline-block;
    box-sizing: border-box;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 2px solid oklch(0.4 0.004 286);
    border-top-color: oklch(0.88 0.006 286);
    animation: chip-spin 0.7s linear infinite;
  }
  @keyframes chip-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .ip {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: oklch(0.58 0.014 252);
    letter-spacing: 0.01em;
    white-space: nowrap;
  }
  .status-text {
    font-size: 0.72rem;
    color: oklch(0.58 0.01 286);
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  /* Unconfigured: the status area is a "Set up your ATEM →" link into Settings.
     The logo stays, so to fit the call-to-action in the fixed-width pill this
     state drops the divider rule and tightens the gap. The link itself matches
     the IP's muted tone (not the accent) and just lightens on hover — its
     animated arrow nudge already signals it's a link (see <ArrowLink>). */
  .chip.setup {
    gap: 9px;
    padding-right: 14px;
  }
  .chip.setup .rule {
    display: none;
  }
  .status :global(.setup-link) {
    --link: oklch(0.58 0.014 252);
    --link-hover: oklch(0.74 0.02 252);
    font-size: 0.68rem;
  }
</style>

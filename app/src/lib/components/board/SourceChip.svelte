<script lang="ts">
  // The source (ATEM) as a matte hardware chip — a milled "Wide Pill" module
  // that sits on the board. UIverse-derived neumorphism (Yaya12085, uiverse.io):
  // dark border + diagonal gradient + inset bevel + a two-tone drop shadow that
  // grounds it on the off-white board. The inputs are its pins (rendered by the
  // board, not here); traces connect later.
  interface Props {
    /** Is the source reachable? Drives the status LED + label. */
    connected?: boolean;
    /** Source IP, shown in mono when connected. */
    ip?: string;
    class?: string;
  }

  let { connected = true, ip = "", class: className = "" }: Props = $props();
</script>

<div class="chip {className}" class:disconnected={!connected}>
  <img src="/bmd-logo.png" alt="Blackmagic Design" class="logo" />
  <span class="rule"></span>
  <div class="status">
    <span class="led" aria-hidden="true"></span>
    {#if connected && ip}
      <span class="ip">{ip}</span>
    {:else}
      <span class="status-text">{connected ? "Connected" : "No source"}</span>
    {/if}
  </div>
</div>

<style>
  /* The pill body. The raised look is the dark border + top-left-lit gradient
     + inset bevel; the drop shadow (dark lower-right, white upper-left) lifts it
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
  /* disconnected: drained LED, no glow (blue is reserved for activity) */
  .chip.disconnected .led {
    background: oklch(0.5 0.003 286);
    box-shadow: none;
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
</style>

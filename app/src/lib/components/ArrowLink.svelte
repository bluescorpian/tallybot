<script lang="ts">
  // A text link that announces "this takes you somewhere": accent colour, a
  // trailing arrow, and an eased colour-shift + arrow nudge on hover/focus so it
  // reads as interactive even before you reach it. Renders an <a> when given an
  // `href`, otherwise a <button> (for links that open an app window via callback).
  //
  // Colours come from two custom properties so it can sit on dark or light
  // surfaces: override `--link` / `--link-hover` on the element. Defaults are
  // tuned for the dark SourceChip.
  import type { Snippet } from "svelte";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";

  interface Props {
    /** Render an anchor to this URL; omit for a button. */
    href?: string;
    /** Button click (ignored when `href` is set). */
    onclick?: () => void;
    class?: string;
    children: Snippet;
  }

  let { href, onclick, class: className = "", children }: Props = $props();
</script>

{#if href}
  <a class="arrow-link {className}" {href}>
    {@render children()}
    <ArrowRight class="arrow" size={14} strokeWidth={2.4} />
  </a>
{:else}
  <button type="button" class="arrow-link {className}" onclick={() => onclick?.()}>
    {@render children()}
    <ArrowRight class="arrow" size={14} strokeWidth={2.4} />
  </button>
{/if}

<style>
  .arrow-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    font: inherit;
    letter-spacing: 0.01em;
    white-space: nowrap;
    text-decoration: none;
    /* Override --link / --link-hover on (or above) the element to retheme;
       defaults are tuned for the dark SourceChip. */
    color: var(--link, color-mix(in oklch, var(--primary), white 14%));
    transition: color 0.22s ease;
  }
  .arrow-link :global(.arrow) {
    transition: transform 0.22s ease;
  }
  .arrow-link:hover,
  .arrow-link:focus-visible {
    color: var(--link-hover, color-mix(in oklch, var(--primary), white 42%));
    outline: none;
  }
  .arrow-link:hover :global(.arrow),
  .arrow-link:focus-visible :global(.arrow) {
    transform: translateX(3px);
  }
</style>

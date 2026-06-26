<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { Snippet } from 'svelte';

  // A small, polished dialog: dimmed + blurred backdrop, a centered card that
  // scales in, Esc / backdrop-click to dismiss, body-scroll lock and a light
  // focus trap. Reused for the work-item create form (and ready for others).
  let {
    title,
    onclose,
    children,
    footer,
    wide = false,
  }: {
    title: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
    wide?: boolean;
  } = $props();

  let panel: HTMLDivElement | null = $state(null);

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
      return;
    }
    if (e.key === 'Tab' && panel !== null) {
      // Keep focus inside the dialog (wrap at the edges).
      const f = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = f[0];
      const last = f[f.length - 1];
      if (first === undefined || last === undefined) return;
      const act = document.activeElement;
      if (e.shiftKey && act === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && act === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  onMount(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus the first field once the panel is in the DOM.
    panel?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Backdrop: click outside the panel closes. -->
<div
  class="backdrop"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
  transition:fade={{ duration: 140 }}
>
  <div
    class="panel"
    class:wide
    role="dialog"
    aria-modal="true"
    aria-label={title}
    bind:this={panel}
    transition:scale={{ duration: 180, start: 0.96, easing: cubicOut }}
  >
    <header class="phead">
      <h2>{title}</h2>
      <button class="x" type="button" aria-label="Close" onclick={onclose}>✕</button>
    </header>
    <div class="pbody">
      {@render children()}
    </div>
    {#if footer}
      <footer class="pfoot">{@render footer()}</footer>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 10vh 20px 20px;
    background: rgba(4, 8, 14, 0.62);
    backdrop-filter: blur(6px) saturate(1.1);
    -webkit-backdrop-filter: blur(6px) saturate(1.1);
  }
  .panel {
    width: 100%;
    max-width: 460px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-3), var(--inset-top), 0 0 0 1px rgba(77, 163, 255, 0.08);
    overflow: hidden;
  }
  .panel.wide {
    max-width: 720px;
  }
  /* A thin cobalt light along the very top edge of the dialog. */
  .phead {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    border-bottom: 1px solid var(--line);
  }
  .phead::before {
    content: '';
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), var(--accent-2), transparent);
  }
  h2 {
    font-size: 16px;
    font-weight: 650;
  }
  .x {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    font-size: 13px;
    transition:
      color var(--transition),
      background var(--transition);
  }
  .x:hover {
    color: var(--text);
    background: var(--panel-3);
  }
  .pbody {
    padding: 18px;
    overflow-y: auto;
  }
  .pfoot {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 18px;
    border-top: 1px solid var(--line);
    background: var(--bg-2);
  }
</style>

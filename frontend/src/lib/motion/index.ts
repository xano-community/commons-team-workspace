// Motion tokens. The same values are CSS variables in components/kit/kit.css (a test keeps them equal): reach for those
// first. Only drag and exits use JavaScript. Nothing moves on a keyboard action, ⌘K, list selection, a route change, row
// hover, a remote update or inside a virtual list. Reduced motion drops movement and keeps fades.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";

export const DURATION = { fast: 100, base: 150, slow: 200, slower: 250 } as const;
export const EASE = [0.23, 1, 0.32, 1] as const;
export const EASE_CSS = `cubic-bezier(${EASE.join(", ")})`;

const QUERY = "(prefers-reduced-motion: reduce)";
const media = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(QUERY) : null);
const subscribe = (fn: () => void) => { const m = media(); m?.addEventListener("change", fn); return () => m?.removeEventListener("change", fn); };

export const prefersReducedMotion = () => !!media()?.matches;
export const useReducedMotion = () => useSyncExternalStore(subscribe, prefersReducedMotion, () => false);

/** How long the reads behind a panel get before it moves in anyway, and how long they must stay quiet to count as done. */
export const SETTLE = { cap: 160, quiet: 16 } as const;

/**
 * Calls `done` once, when `client` has had nothing loading for `quiet` ms (a panel's reads, and the ones they lead to, have
 * landed), or after `cap` ms whatever is still loading. A panel that moves in waits on this, so it arrives drawn and nothing
 * inside it shifts after it lands. Returns a stop function.
 */
export function whenSettled(client: QueryClient, done: () => void, { cap = SETTLE.cap as number, quiet = SETTLE.quiet as number }: { cap?: number; quiet?: number } = {}) {
  let finished = false;
  let calm: ReturnType<typeof setTimeout> | undefined;
  const finish = () => { if (finished) return; finished = true; stop(); done(); };
  const check = () => {
    clearTimeout(calm);
    if (client.isFetching() === 0) calm = setTimeout(() => { if (client.isFetching() === 0) finish(); else check(); }, quiet);
  };
  const unsubscribe = client.getQueryCache().subscribe(check);
  const limit = setTimeout(finish, cap);
  const stop = () => { finished = true; unsubscribe(); clearTimeout(calm); clearTimeout(limit); };
  check();
  return stop;
}

/** True once the panel's reads have settled (see whenSettled). `wait` false: true at once. */
export function useSettled(client: QueryClient, wait: boolean, options?: { cap?: number; quiet?: number }) {
  const [settled, setSettled] = useState(!wait);
  useEffect(() => (settled ? undefined : whenSettled(client, () => setSettled(true), options)), [client, settled]); // eslint-disable-line react-hooks/exhaustive-deps
  return settled;
}

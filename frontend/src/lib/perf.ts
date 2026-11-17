// The speed budgets, measured where a person feels them. Each interaction is a performance.measure from its input event
// to the paint that shows the result, so the browser's own timeline and the QA gates read the same numbers.
export const BUDGETS = {
  "palette-open": { p75: 50, p95: 100 },
  navigation: { p75: 100, p95: 200 },
  optimistic: { p75: 50, p95: 100 },
} as const;
export type Interaction = keyof typeof BUDGETS;

const KEEP = 100;
const starts = new Map<Interaction, number>();

/** Nearest-rank percentile. */
export const percentile = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? 0;
};

export const withinBudget = (name: Interaction, samples: number[]) =>
  percentile(samples, 75) <= BUDGETS[name].p75 && percentile(samples, 95) <= BUDGETS[name].p95;

function end(name: Interaction) {
  const start = starts.get(name);
  if (start === undefined) return;
  starts.delete(name);
  if (performance.getEntriesByName(name, "measure").length >= KEEP) performance.clearMeasures(name);
  performance.measure(name, { start, end: performance.now(), detail: { budget: BUDGETS[name] } });
}

export const perf = {
  /** `at` is the input event's own timestamp, where there is one: the time it waited in the queue counts. */
  start(name: Interaction, at: number = window.event?.timeStamp ?? performance.now()) { starts.set(name, at); },
  /** Ends the measure in the task after the next frame, once the browser has painted it. */
  endAfterPaint(name: Interaction) {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => end(name);
      channel.port2.postMessage(0);
    });
  },
  samples: (name: Interaction) => performance.getEntriesByName(name, "measure").map((m) => m.duration),
};

/**
 * Runs each loader in turn, the next only once the last has settled and `later` has found a quiet moment. A loader that fails
 * doesn't stop the rest. Answers the function that stops it.
 */
export function loadInTurn(loaders: (() => unknown)[], later: (next: () => void) => () => void): () => void {
  let at = 0, stopped = false;
  let cancel = () => {};
  const next = () => {
    if (stopped || at >= loaders.length) return;
    const load = loaders[at++];
    void Promise.resolve().then(load).catch(() => { /* a screen that fails here loads, or says so, when it's opened */ }).finally(() => { if (!stopped) cancel = later(next); });
  };
  cancel = later(next);
  return () => { stopped = true; cancel(); };
}

/** The browser's next idle moment, or a short wait where it has none. */
export function whenIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") { const id = window.requestIdleCallback(fn, { timeout: 5000 }); return () => window.cancelIdleCallback(id); }
  const id = setTimeout(fn, 300);
  return () => clearTimeout(id);
}

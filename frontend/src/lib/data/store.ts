// The only data that survives a closed tab: this person's drafts and unsent writes, keyed by their user id, so someone
// else signing in on this browser never sees them and they come back when the same person returns.
const key = (kind: string, userId: number) => `commons.${kind}.${userId}`;

export function readStore<T>(kind: string, userId: number, fallback: T): T {
  try {
    const raw = localStorage.getItem(key(kind, userId));
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch { return fallback; }
}

export function writeStore(kind: string, userId: number, value: unknown): void {
  try { localStorage.setItem(key(kind, userId), JSON.stringify(value)); } catch { /* storage off or full: the work stays in memory */ }
}

export function clearStore(kind: string, userId: number): void {
  try { localStorage.removeItem(key(kind, userId)); } catch { /* storage off */ }
}

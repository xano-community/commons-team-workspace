// The one request helper (CRAFT.md §4): the base URL the deploy injects, the Bearer token, JSON, plain-words
// errors, and 401 → sign out. The domain's lib/api.ts builds on it; paths come from xano/routes.gen.ts.

declare global {
  interface Window {
    XANO_HOST?: string;
  }
}

export const XANO_HOST: string = (typeof window !== "undefined" && window.XANO_HOST) || import.meta.env.VITE_XANO_HOST || "";

const KEY = "app.token";
const read = (store: () => Storage) => { try { return store().getItem(KEY); } catch { return null; } };
const write = (store: () => Storage, t: string | null) => { try { if (t) store().setItem(KEY, t); else store().removeItem(KEY); } catch { /* sandboxed */ } };
const windowStore = () => sessionStorage;
const sharedStore = () => localStorage;

/**
 * The person's session token, inside try/catch (a sandboxed frame throws). A real session is shared by the browser's
 * tabs through localStorage. A demo session belongs to one window, in sessionStorage, so two windows can be two
 * people, and it wins over a shared token in its own window.
 */
export const token = {
  get: (): string | null => read(windowStore) ?? read(sharedStore),
  /** True when this window runs its own session, which a change in another tab doesn't touch. */
  isWindowOnly: (): boolean => read(windowStore) !== null,
  set: (t: string | null, opts: { windowOnly?: boolean } = {}) => {
    if (opts.windowOnly) { write(windowStore, t); return; }
    if (t === null && read(windowStore) !== null) { write(windowStore, null); return; }
    write(windowStore, null);
    write(sharedStore, t);
  },
};

/** Calls `fn` when another tab signs in, signs out or changes person. A window with its own session ignores it. */
export function onSharedTokenChange(fn: () => void): () => void {
  const listener = (e: StorageEvent) => {
    if ((e.key === KEY || e.key === null) && e.storageArea === localStorage && !token.isWindowOnly()) fn();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

/** An error with the HTTP status, so a screen can tell a 404 from a 500 (and modules a 429). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export class Unauthorized extends ApiError {
  constructor(message = "Your session ended. Sign in again.") { super(message, 401); }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

/** A query string from the set values only: qs({ q: "", page: "2" }) → "?page=2". */
export const qs = (q: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export async function request<T>(verb: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const t = token.get();
  if (t) headers.authorization = `Bearer ${t}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(XANO_HOST + path, { method: verb, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("We can't reach the server. Check your connection, then try again.", 0);
  }
  if (res.status >= 500) throw new ApiError("The server had a problem with that request. Try again in a moment.", res.status);
  if (res.status === 401) {
    // Only the token that failed is dropped: another tab may have signed in with a new one meanwhile.
    if (t && token.get() === t) { token.set(null); onUnauthorized(); }
    const j = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Unauthorized(t ? undefined : j?.message || "Sign in to continue.");
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(j?.message || `That didn't work (${res.status}).`, res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

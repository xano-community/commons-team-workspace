// A backend that can vanish says so. A Xano Engine runs on this machine and an ephemeral expires: `npm run
// xano:deploy:ephemeral` builds with `--mode ephemeral`, because nothing in an ephemeral's URL marks it as one.
import { XANO_HOST } from "./request";

export const isLocalEngine = (host: string) => /^https?:\/\/((?:[^/]+\.)?localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(host);
export const isDemoBackend = (host: string, mode: string) => mode === "ephemeral" || isLocalEngine(host);

export function DemoBanner() {
  if (!isDemoBackend(XANO_HOST, import.meta.env.MODE)) return null;
  return <p data-kit="demo-banner" className="shrink-0 border-b bg-muted/50 px-3 py-1 text-center text-caption text-muted-foreground sm:px-4">Demo backend. Data here can disappear.</p>;
}

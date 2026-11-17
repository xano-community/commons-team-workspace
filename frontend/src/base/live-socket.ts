// The one websocket, without React: joining and rejoining, presence, pings, reconnects and what a refused token means.
// An expired token doesn't close the socket, it connects anonymously and every join comes back as an error frame naming
// `token_error`. So that frame, like a 4401 close, ends this connection: the screens poll, and it stays down until
// there's a new token to try. Reconnecting with the old one would only be refused again.
export type LiveState = "connecting" | "live" | "offline";
/** `channel` and `seq` are set on a logged channel, so a gap can be noticed. */
export type LiveChange = { entity: string; id: number | null; op: string; actor_id: number | null; channel?: string; seq?: number; at?: number };
/** Something moved in this person's inbox. Ids only: every tab refetches what it may see. */
export type LiveInbox = { id: number; op: string; kind: string; link: string; actor_id: number | null; channel: string; seq: number };
export type ChannelMessage = { channel: string; type: string; payload: Record<string, unknown> };
export type ChannelStatus = "joining" | "joined" | "refused";
type Member = { id: string };
type Frame = {
  action: string;
  channel?: string;
  type?: string;
  token_error?: string;
  payload?: Record<string, unknown> & { members?: Member[]; member?: Member; token_error?: string };
};

export type LiveHandlers = {
  onState: (s: LiveState) => void;
  onChange: (c: LiveChange) => void;
  onInbox: (n: LiveInbox) => void;
  /** This person lost access: to one space, or with no `spaceId` to everything. */
  onPurge: (spaceId?: number) => void;
  onMessage: (m: ChannelMessage) => void;
  onChannelStatus: (channel: string, status: ChannelStatus) => void;
  onPresence: (channel: string, update: (ids: number[]) => number[]) => void;
  /** The server refused this token. Whoever holds the session decides what happens next. */
  onTokenRefused: () => void;
};
type Options = {
  url: string;
  userId: number;
  /** Guests stay off the shared `app` channel: it shows everyone online. They get changes from their spaces' channels. */
  shared: boolean;
  token: () => string | null;
  handlers: LiveHandlers;
  socket?: (url: string, token: string) => WebSocket;
};

const JOIN_DELAY_MS = 250;   // the server's context is ready a moment after open: an immediate first frame is refused
const PING_MS = 30_000;      // a listen-only socket is dropped after ~10 minutes idle
const REFUSED_CLOSE = 4401;

const memberId = (m?: Member) => Number(m?.id ?? 0);
const presenceUpdate = (f: Frame): ((ids: number[]) => number[]) | null => {
  if (f.action === "presence_full") return () => [...new Set((f.payload?.members ?? []).map(memberId).filter(Boolean))];
  if (f.action === "presence_join") return (ids) => [...new Set([...ids, memberId(f.payload?.member)].filter(Boolean))];
  if (f.action === "presence_leave") return (ids) => ids.filter((x) => x !== memberId(f.payload?.member));
  return null;
};

export function createLiveSocket({ url, userId, shared, token, handlers, socket = (u, t) => new WebSocket(u, t) }: Options) {
  const own = [...(shared ? ["app"] : []), `users/${userId}`];
  const wanted = new Map<string, number>();   // channel → how many screens want it
  let sock: WebSocket | null = null;
  let stopped = false, refused = false, ready = false, attempt = 0;
  let ping: ReturnType<typeof setInterval> | undefined, retry: ReturnType<typeof setTimeout> | undefined;

  const send = (frame: object) => { if (ready && sock?.readyState === 1) sock.send(JSON.stringify(frame)); };

  const refuse = () => {
    if (refused) return;
    refused = true;
    handlers.onState("offline");
    handlers.onTokenRefused();
    sock?.close();
  };

  const onFrame = (f: Frame) => {
    if (f.action === "error") {
      if (f.payload?.token_error ?? f.token_error) return refuse();
      if (f.channel && wanted.has(f.channel)) handlers.onChannelStatus(f.channel, "refused");
      return;
    }
    if (f.action === "join" && f.channel) {
      if (own.includes(f.channel)) {
        handlers.onState("live");
        // Back after a gap: anything sent meanwhile was missed, so every screen refreshes once.
        if (attempt > 0) handlers.onChange({ entity: "*", id: null, op: "reconnected", actor_id: null });
        attempt = 0;
      }
      if (wanted.has(f.channel) || own.includes(f.channel)) handlers.onChannelStatus(f.channel, "joined");
    }
    if (f.action === "leave" && f.channel && f.payload?.kicked && wanted.has(f.channel)) handlers.onChannelStatus(f.channel, "refused");
    if (f.action === "message" && f.channel) {
      const p = f.payload ?? {};
      if (f.type === "changed") {
        handlers.onChange({
          entity: String(p.entity ?? ""), id: p.id == null ? null : Number(p.id), op: String(p.op ?? ""), actor_id: p.actor_id == null ? null : Number(p.actor_id),
          ...(p.seq == null ? {} : { channel: f.channel, seq: Number(p.seq) }),
          ...(p.at == null ? {} : { at: Number(p.at) }),
        });
      } else if (f.channel === `users/${userId}` && f.type === "inbox") {
        handlers.onInbox({ id: Number(p.id), op: String(p.op ?? ""), kind: String(p.kind ?? ""), link: String(p.link ?? ""), actor_id: p.actor_id == null ? null : Number(p.actor_id), channel: f.channel, seq: Number(p.seq) });
      } else if (f.channel === `users/${userId}` && f.type === "purge") {
        handlers.onPurge(p.space_id == null ? undefined : Number(p.space_id));
      } else handlers.onMessage({ channel: f.channel, type: f.type ?? "", payload: p });
    }
    const update = f.channel ? presenceUpdate(f) : null;
    if (update) handlers.onPresence(f.channel!, update);
  };

  const open = () => {
    const t = token();
    if (!t || stopped) return;
    handlers.onState("connecting");
    const s = socket(url, t);
    sock = s;
    s.onopen = () => {
      setTimeout(() => {
        if (s.readyState !== 1) return;
        ready = true;
        for (const channel of [...own, ...wanted.keys()]) s.send(JSON.stringify({ action: "join", channel }));
      }, JOIN_DELAY_MS);
      ping = setInterval(() => { if (s.readyState === 1) s.send(JSON.stringify({ action: "ping" })); }, PING_MS);
    };
    s.onmessage = (e) => {
      let f: Frame;
      try { f = JSON.parse(String(e.data)) as Frame; } catch { return; }
      onFrame(f);
    };
    s.onclose = (e) => {
      clearInterval(ping);
      ready = false;
      if (sock === s) sock = null;
      if (stopped) return;
      handlers.onState("offline");
      if (refused) return;
      if (e.code === REFUSED_CLOSE) { refuse(); return; }
      attempt += 1;
      retry = setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    };
  };

  return {
    start: open,
    stop() { stopped = true; clearInterval(ping); clearTimeout(retry); sock?.close(); sock = null; },
    /** There's a new token: try again. Anything sent while the socket was down gets refreshed by the rejoin. */
    resume() {
      if (!refused && sock) return;
      refused = false;
      attempt = Math.max(attempt, 1);
      clearTimeout(retry);
      open();
    },
    /** A frame of this client's own, on a channel that takes them. Dropped while the socket is down: nothing that matters goes this way. */
    broadcast(channel: string, type: string, payload: object) { send({ action: "broadcast", channel, type, payload }); },
    /** Wants a channel until the returned function runs. Several screens may want the same one. */
    join(channel: string) {
      const n = wanted.get(channel) ?? 0;
      wanted.set(channel, n + 1);
      if (n === 0) { handlers.onChannelStatus(channel, "joining"); send({ action: "join", channel }); }
      return () => {
        const left = (wanted.get(channel) ?? 1) - 1;
        if (left > 0) { wanted.set(channel, left); return; }
        wanted.delete(channel);
        send({ action: "leave", channel });
      };
    },
  };
}

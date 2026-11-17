// Live updates (BASELINE.md "Live"): one websocket per signed-in tab, to the backend's `live` server.
//   - Every "changed" frame goes through applyEntityEvent, so the query cache refreshes itself.
//   - `useLive("job", reload)`: a screen on useLoad reloads when someone else changes a job.
//   - `useChannel("spaces/3", fn)`: joins any channel, gets its messages, and says if it was refused.
//   - `<SpaceChannels ids={…} />`: the shell keeps a channel open for each of this person's spaces.
//   - `useInboxPush(fn)`: an inbox item arrived, was read or left, in this tab or another.
//   - Each logged channel keeps a sequence number, and asks `changes` what it missed: on a gap, on a reconnect, on coming
//     back to the tab and once a minute, because a frame can be lost.
//   - `useOnline()` / `useRoom(roomOf("space", 12))`: who's here, and who's looking at this record.
//   - `useLiveChange(fn)`: every change as it lands, undebounced, for a screen that has its own way of catching up.
//   - `useBroadcast()`: a frame of this client's own, for a channel that takes them (typing).
// The socket is an enhancement: every screen loads over HTTP first, and while the socket is down, an expired token
// included, `useLive` polls every 30 s instead, so nothing breaks when it can't connect.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { channelPath, socketUrl } from "../../../xano/routes.gen.js";
import { applyEntityEvent, createChangeFollower, purgeDrafts, purgeOutbox, type ChangeEntry } from "@/lib/data";
import { blockOutbox } from "@/lib/chat/client";
import { shellToast } from "@/lib/toast";
import { createLiveSocket, type ChannelMessage, type ChannelStatus, type LiveChange, type LiveInbox, type LiveState } from "./live-socket";
import { baseApi } from "./api";
import { XANO_HOST, token } from "./request";

export type { LiveChange, LiveInbox, LiveState };
type Socket = ReturnType<typeof createLiveSocket>;
type ChannelListener = { onMessage?: (m: ChannelMessage) => void; onStatus: (s: ChannelStatus) => void };
type Ctx = {
  state: LiveState;
  me: number;
  online: number[];
  rooms: Record<string, number[]>;
  onChange: (fn: (c: LiveChange) => void) => () => void;
  onInbox: (fn: (n: LiveInbox) => void) => () => void;
  channel: (channel: string, listener: ChannelListener) => () => void;
  broadcast: (channel: string, type: string, payload: object) => void;
};
const LiveContext = createContext<Ctx | null>(null);

const CATCH_UP_MS = 60_000;
const INBOX_COUNT = "notification-count";
/** The channels with a change log. Rooms and typing carry nothing to catch up on, and `app` has no numbers. */
const isLogged = (channel: string) => channel === "crm" || channel.startsWith("users/") || channel.startsWith("spaces/");

/** A room is named `<type>-<id>`: the server reads that to check this person may reach the record. */
export const roomOf = (type: string, id: number) => `${type}-${id}`;

/** `epoch` moves when the session gets a new token, which is the one thing that brings back a refused socket. */
export function LiveProvider({ userId, guest = false, epoch = 0, children }: { userId: number; guest?: boolean; epoch?: number; children: ReactNode }) {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");
  const [online, setOnline] = useState<number[]>([]);
  const [rooms, setRooms] = useState<Record<string, number[]>>({});
  const changeFns = useRef(new Set<(c: LiveChange) => void>());
  const inboxFns = useRef(new Set<(n: LiveInbox) => void>());
  const channels = useRef(new Map<string, Set<ChannelListener>>());
  const leaves = useRef(new Map<ChannelListener, () => void>());
  const socket = useRef<Socket | null>(null);
  const followerRef = useRef<ReturnType<typeof createChangeFollower> | null>(null);

  useEffect(() => {
    let url = "";
    try { url = XANO_HOST ? socketUrl("live", XANO_HOST) : ""; } catch { url = ""; }
    if (!url) { setState("offline"); return; }
    const change = (c: LiveChange) => {
      applyEntityEvent(client, { type: "remote", entity: c.entity, id: c.id, op: c.op });
      void client.invalidateQueries({ queryKey: c.entity === "*" ? ["record"] : ["record", c.entity] });
      for (const fn of changeFns.current) fn(c);
    };
    const inboxMoved = () => {
      applyEntityEvent(client, { type: "remote", entity: "notification", id: null });
      applyEntityEvent(client, { type: "remote", entity: INBOX_COUNT, id: null });
    };
    const missed = (_channel: string, e: ChangeEntry) => {
      if (e.entity === "notification") inboxMoved();
      else change({ entity: e.entity, id: e.entity_id, op: e.op, actor_id: e.actor_id, at: e.at });
    };
    const own = `users/${userId}`;
    const follower = createChangeFollower({ read: baseApi.changes, apply: missed, started: (channel) => { if (channel === own) inboxMoved(); } });
    followerRef.current = follower;
    const live = createLiveSocket({
      url, userId, shared: !guest, token: () => token.get(),
      handlers: {
        onState: (s) => {
          setState(s);
          if (s === "live") void follower.catchUp();
        },
        onChange: (c) => { if (!c.channel || follower.saw(c.channel, c.seq ?? 0)) change(c); },
        onInbox: (n) => {
          if (follower.saw(n.channel, n.seq)) inboxMoved();
          for (const fn of inboxFns.current) fn(n);
        },
        onPurge: (spaceId) => {
          purgeDrafts(userId, spaceId);
          purgeOutbox(userId, spaceId);
          blockOutbox(userId, spaceId);
          void client.resetQueries();
          shellToast.show(spaceId === undefined ? "Your access changed." : "You're no longer in one of your spaces.");
        },
        onMessage: (m) => { for (const l of channels.current.get(m.channel) ?? []) l.onMessage?.(m); },
        onChannelStatus: (channel, status) => {
          if (isLogged(channel)) {
            if (status === "joined") follower.follow(channel);
            if (status === "refused") follower.forget(channel);
          }
          for (const l of channels.current.get(channel) ?? []) l.onStatus(status);
        },
        onPresence: (channel, update) => {
          if (channel === "app") setOnline(update);
          else if (channel.startsWith("rooms/")) {
            const r = channel.slice(6);
            setRooms((all) => ({ ...all, [r]: update(all[r] ?? []) }));
          }
        },
        // Ask over HTTP: a 401 there opens the sign-in dialog, and anything else means the token is fine after all.
        onTokenRefused: () => { baseApi.me().catch(() => {}); },
      },
    });
    socket.current = live;
    // A child's effect runs before this one, so what the shell asks for as it first mounts is already waiting here.
    for (const [name, listeners] of channels.current) for (const l of listeners) leaves.current.set(l, live.join(name));
    live.start();
    const back = () => { if (document.visibilityState === "visible") void follower.catchUp(); };
    const slowly = setInterval(back, CATCH_UP_MS);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      live.stop();
      socket.current = null;
      followerRef.current = null;
      clearInterval(slowly);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [userId, guest, client]);

  useEffect(() => { if (epoch) socket.current?.resume(); }, [epoch]);

  // A hook for QA and the header's dot: <html data-live="live|connecting|offline">.
  useEffect(() => { document.documentElement.dataset.live = state; }, [state]);

  // Stable callbacks: a screen's effect depends on them, so they must not change when presence does.
  const onChange = useCallback((fn: (c: LiveChange) => void) => { changeFns.current.add(fn); return () => { changeFns.current.delete(fn); }; }, []);
  const onInbox = useCallback((fn: (n: LiveInbox) => void) => { inboxFns.current.add(fn); return () => { inboxFns.current.delete(fn); }; }, []);
  const channel = useCallback((name: string, listener: ChannelListener) => {
    const listeners = channels.current.get(name) ?? new Set();
    channels.current.set(name, listeners);
    listeners.add(listener);
    const leave = socket.current?.join(name);
    if (leave) leaves.current.set(listener, leave);
    return () => {
      leaves.current.get(listener)?.();
      leaves.current.delete(listener);
      listeners.delete(listener);
      if (!listeners.size) { channels.current.delete(name); followerRef.current?.forget(name); }
      if (name.startsWith("rooms/")) setRooms((all) => { const { [name.slice(6)]: _gone, ...rest } = all; void _gone; return rest; });
    };
  }, []);
  const broadcast = useCallback((name: string, type: string, payload: object) => socket.current?.broadcast(name, type, payload), []);
  const value = useMemo<Ctx>(() => ({ state, me: userId, online, rooms, onChange, onInbox, channel, broadcast }), [state, userId, online, rooms, onChange, onInbox, channel, broadcast]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

const useCtx = () => useContext(LiveContext);

/** "live" | "connecting" | "offline" ("offline" outside the signed-in shell). */
export const useLiveState = (): LiveState => useCtx()?.state ?? "offline";

/**
 * Reload when one of these entities changes on the server (by anyone, including you in another tab); "*" is any.
 * `reload` should keep the old data on screen while it loads, as the kit's `useLoad` does. Debounced, so a
 * burst of changes is one reload. While the socket is down it polls instead (every `pollMs`).
 */
export function useLive(entities: string | string[], reload: () => void, { pollMs = 30_000 }: { pollMs?: number } = {}) {
  const ctx = useCtx();
  const ref = useRef(reload);
  ref.current = reload;
  const key = Array.isArray(entities) ? entities.join(",") : entities;
  useEffect(() => {
    if (!ctx) return;
    const want = new Set(key.split(","));
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = ctx.onChange((c) => {
      if (c.entity !== "*" && !want.has("*") && !want.has(c.entity)) return;
      clearTimeout(t);
      t = setTimeout(() => ref.current(), 150);
    });
    return () => { off(); clearTimeout(t); };
  }, [ctx?.onChange, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const offline = ctx?.state === "offline";
  useEffect(() => {
    if (!offline || !pollMs) return;
    // With no token the sign-in dialog is up, and a poll could only fail behind it.
    const i = setInterval(() => document.visibilityState === "visible" && token.get() && ref.current(), pollMs);
    return () => clearInterval(i);
  }, [offline, pollMs]);
}

/** Every change as it lands, with no debounce and no polling. The screen catches up for itself. */
export function useLiveChange(fn: (c: LiveChange) => void) {
  const ctx = useCtx();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => ctx?.onChange((c) => ref.current(c)), [ctx?.onChange]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Sends a frame on a channel this screen has joined. */
export const useBroadcast = () => useCtx()?.broadcast;

/**
 * Joins a channel while mounted, and rejoins after a reconnect. `onMessage` gets its messages; the status says whether
 * the server let this person in. Pass null to join nothing. Use `channelPath()` from routes.gen for the name.
 */
export function useChannel(channel: string | null, onMessage?: (m: ChannelMessage) => void): ChannelStatus | null {
  const ctx = useCtx();
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const ref = useRef(onMessage);
  ref.current = onMessage;
  useEffect(() => {
    if (!channel || !ctx) return;
    setStatus("joining");
    const off = ctx.channel(channel, { onMessage: (m) => ref.current?.(m), onStatus: setStatus });
    return () => { off(); setStatus(null); };
  }, [channel, ctx?.channel]); // eslint-disable-line react-hooks/exhaustive-deps
  return status;
}

/** One space's channel, while mounted. Its "changed" frames reach the cache like the `app` channel's do. */
function SpaceChannel({ id }: { id: number }) {
  useChannel(channelPath("spaces/{space_id}", { space_id: id }));
  return null;
}

/** Keeps a channel open for each space. It's how a guest, who isn't on `app`, hears about anything at all. */
export const SpaceChannels = ({ ids }: { ids: number[] }) => <>{ids.map((id) => <SpaceChannel key={id} id={id} />)}</>;

/** The CRM's channel, for people who hold crm.read. */
export function CrmChannel() {
  useChannel("crm");
  return null;
}

/** Run `fn` when something moves in the signed-in person's inbox. */
export function useInboxPush(fn: (n: LiveInbox) => void) {
  const ctx = useCtx();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => ctx?.onInbox((n) => ref.current(n)), [ctx?.onInbox]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The ids of everyone signed in with the app open right now (you included once your socket joins). */
export const useOnline = (): number[] => useCtx()?.online ?? [];

/** Who else is looking at this record or board right now (ids, not you). Pass null to join nothing. */
export function useRoom(room: string | null): number[] {
  const ctx = useCtx();
  useChannel(room && `rooms/${room}`);
  const ids = room && ctx ? ctx.rooms[room] ?? [] : [];
  return ids.filter((id) => id !== ctx?.me);
}

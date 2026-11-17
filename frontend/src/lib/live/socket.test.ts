import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveSocket, type LiveHandlers } from "@/base/live-socket";

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: { action: string; channel?: string }[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  constructor(readonly url: string, readonly token: string) { FakeSocket.all.push(this); }
  send(f: string) { this.sent.push(JSON.parse(f)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  frame(f: object) { this.onmessage?.({ data: JSON.stringify(f) }); }
  joined() { return this.sent.filter((f) => f.action === "join").map((f) => f.channel); }
}

const handlers = (): LiveHandlers => ({ onState: vi.fn(), onChange: vi.fn(), onInbox: vi.fn(), onPurge: vi.fn(), onMessage: vi.fn(), onChannelStatus: vi.fn(), onPresence: vi.fn(), onTokenRefused: vi.fn() });
let h: LiveHandlers;
const connect = (shared = true) => {
  const live = createLiveSocket({ url: "ws://x", userId: 7, shared, token: () => "t", handlers: h, socket: (u, t) => new FakeSocket(u, t) as unknown as WebSocket });
  live.start();
  const s = FakeSocket.all.at(-1)!;
  s.onopen?.();
  vi.advanceTimersByTime(300);
  return { live, s };
};

beforeEach(() => { vi.useFakeTimers(); FakeSocket.all = []; h = handlers(); });
afterEach(() => { vi.useRealTimers(); });

describe("connecting", () => {
  it("joins its own channels a moment after open, and is live once the server agrees", () => {
    const { s } = connect();
    expect(s.joined()).toEqual(["app", "users/7"]);
    s.frame({ action: "join", channel: "app" });
    expect(h.onState).toHaveBeenLastCalledWith("live");
  });

  it("keeps a guest off the app channel, and counts them as live on their own", () => {
    const { s } = connect(false);
    expect(s.joined()).toEqual(["users/7"]);
    s.frame({ action: "join", channel: "users/7" });
    expect(h.onState).toHaveBeenLastCalledWith("live");
    expect(h.onTokenRefused).not.toHaveBeenCalled();
  });

  it("reconnects after a drop, rejoins, and asks every screen to refresh", () => {
    const { live, s } = connect();
    const off = live.join("spaces/3");
    s.onclose?.({ code: 1006 });
    expect(h.onState).toHaveBeenLastCalledWith("offline");
    vi.advanceTimersByTime(2100);
    const next = FakeSocket.all.at(-1)!;
    expect(next).not.toBe(s);
    next.onopen?.();
    vi.advanceTimersByTime(300);
    expect(next.joined()).toContain("spaces/3");
    next.frame({ action: "join", channel: "app" });
    expect(h.onChange).toHaveBeenCalledWith({ entity: "*", id: null, op: "reconnected", actor_id: null });
    off();
  });
});

describe("a refused token", () => {
  it("goes offline on an error frame naming token_error, and doesn't retry the same token", () => {
    const { s } = connect();
    s.frame({ action: "error", payload: { message: "Your token has expired.", token_error: "expired" } });
    expect(h.onState).toHaveBeenLastCalledWith("offline");
    expect(h.onTokenRefused).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("treats the server's 4401 close the same way", () => {
    const { s } = connect();
    s.onclose?.({ code: 4401 });
    expect(h.onTokenRefused).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("comes back when there's a new token", () => {
    const { live, s } = connect();
    s.frame({ action: "error", payload: { token_error: "expired" } });
    live.resume();
    expect(FakeSocket.all).toHaveLength(2);
  });
});

describe("channels", () => {
  it("joins once for several screens, leaves with the last, and reports the answer", () => {
    const { live, s } = connect();
    const a = live.join("spaces/3"), b = live.join("spaces/3");
    expect(s.joined().filter((c) => c === "spaces/3")).toHaveLength(1);
    s.frame({ action: "join", channel: "spaces/3" });
    expect(h.onChannelStatus).toHaveBeenLastCalledWith("spaces/3", "joined");
    a();
    expect(s.sent.some((f) => f.action === "leave")).toBe(false);
    b();
    expect(s.sent.at(-1)).toEqual({ action: "leave", channel: "spaces/3" });
  });

  it("says when the server refuses a channel, or kicks someone out of it", () => {
    const { live, s } = connect();
    live.join("spaces/3");
    s.frame({ action: "error", channel: "spaces/3", payload: { message: "No" } });
    expect(h.onChannelStatus).toHaveBeenLastCalledWith("spaces/3", "refused");
    s.frame({ action: "join", channel: "spaces/3" });
    s.frame({ action: "leave", channel: "spaces/3", payload: { left: true, kicked: true } });
    expect(h.onChannelStatus).toHaveBeenLastCalledWith("spaces/3", "refused");
  });

  it("sends a channel's messages on, and reads a change from any channel", () => {
    const { s } = connect();
    s.frame({ action: "message", channel: "spaces/3", type: "typing", payload: { who: 1 } });
    expect(h.onMessage).toHaveBeenCalledWith({ channel: "spaces/3", type: "typing", payload: { who: 1 } });
    s.frame({ action: "message", channel: "spaces/3", type: "changed", payload: { entity: "task", id: 4, op: "update", actor_id: 2 } });
    expect(h.onChange).toHaveBeenCalledWith({ entity: "task", id: 4, op: "update", actor_id: 2 });
  });

  it("passes on a purge from this person's channel", () => {
    const { s } = connect();
    s.frame({ action: "message", channel: "users/7", type: "purge", payload: { space_id: 3 } });
    expect(h.onPurge).toHaveBeenCalledWith(3);
  });
});

describe("frames that carry a sequence", () => {
  it("says when this person's own channel is joined, so following starts only once frames can arrive", () => {
    const { s } = connect();
    s.frame({ action: "join", channel: "app" });
    expect(h.onChannelStatus).not.toHaveBeenCalledWith("users/7", "joined");
    s.frame({ action: "join", channel: "users/7" });
    expect(h.onChannelStatus).toHaveBeenCalledWith("users/7", "joined");
  });

  it("passes a change's channel and number on, so a gap can be noticed", () => {
    const { s } = connect();
    s.frame({ action: "message", channel: "spaces/3", type: "changed", payload: { entity: "task", id: 4, op: "updated", actor_id: 2, seq: 9 } });
    expect(h.onChange).toHaveBeenCalledWith({ entity: "task", id: 4, op: "updated", actor_id: 2, channel: "spaces/3", seq: 9 });
  });

  it("reads an inbox frame on this person's own channel, and only there", () => {
    const { s } = connect();
    s.frame({ action: "message", channel: "users/7", type: "inbox", payload: { id: 4, op: "created", kind: "mention", link: "/chat/1", actor_id: 2, seq: 3 } });
    expect(h.onInbox).toHaveBeenCalledWith({ id: 4, op: "created", kind: "mention", link: "/chat/1", actor_id: 2, channel: "users/7", seq: 3 });
    s.frame({ action: "message", channel: "users/8", type: "inbox", payload: { id: 5 } });
    expect(h.onInbox).toHaveBeenCalledTimes(1);
  });
});

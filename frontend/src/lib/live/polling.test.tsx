import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

class FakeSocket {
  static last: FakeSocket;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  constructor() { FakeSocket.last = this; }
  send() {}
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))));
  window.XANO_HOST = "http://backend.test";
  localStorage.setItem("app.token", "t");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

it("an expired token starts polling, with no reload until then", async () => {
  const { LiveProvider, useLive } = await import("@/base/live");
  const reload = vi.fn();
  const Screen = () => { useLive("task", reload); return null; };
  const wrap = (children: ReactNode) => <QueryClientProvider client={new QueryClient()}><LiveProvider userId={7}>{children}</LiveProvider></QueryClientProvider>;
  render(wrap(<Screen />));
  act(() => { FakeSocket.last.onopen?.(); vi.advanceTimersByTime(300); });
  act(() => { FakeSocket.last.onmessage?.({ data: JSON.stringify({ action: "join", channel: "app" }) }); });
  expect(document.documentElement.dataset.live).toBe("live");
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(reload).not.toHaveBeenCalled();

  act(() => { FakeSocket.last.onmessage?.({ data: JSON.stringify({ action: "error", payload: { message: "Your token has expired.", token_error: "expired" } }) }); });
  expect(document.documentElement.dataset.live).toBe("offline");
  act(() => { vi.advanceTimersByTime(30_000); });
  expect(reload).toHaveBeenCalledTimes(1);
  act(() => { vi.advanceTimersByTime(30_000); });
  expect(reload).toHaveBeenCalledTimes(2);
});

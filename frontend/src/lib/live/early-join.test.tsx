import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const joined: string[] = [];
const left: string[] = [];
vi.mock("@/base/live-socket", () => ({
  createLiveSocket: () => ({ start() {}, stop() {}, resume() {}, broadcast() {}, join: (name: string) => { joined.push(name); return () => left.push(name); } }),
}));
vi.mock("@/base/request", async (real) => ({ ...(await real<object>()), XANO_HOST: "http://backend.test", token: { get: () => "t" } }));

const { LiveProvider, useChannel } = await import("@/base/live");
const Early = () => { useChannel("crm"); return null; };
const tree = () => <QueryClientProvider client={new QueryClient()}><LiveProvider userId={1}><Early /></LiveProvider></QueryClientProvider>;

describe("a channel asked for as the shell first mounts", () => {
  afterEach(() => { cleanup(); joined.length = 0; left.length = 0; });
  it("is joined, even though its effect runs before the socket exists", () => {
    render(tree());
    expect(joined).toEqual(["crm"]);
  });
  it("is left again when the screen goes", () => {
    const { rerender } = render(tree());
    rerender(<QueryClientProvider client={new QueryClient()}><LiveProvider userId={1}>{null}</LiveProvider></QueryClientProvider>);
    cleanup();
    expect(left).toContain("crm");
  });
});

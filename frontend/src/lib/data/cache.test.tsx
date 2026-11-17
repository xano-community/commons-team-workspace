import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "./client";
import { useDraft } from "./drafts";
import { applyEntityEvent } from "./entities";
import { useEntityQuery } from "./hooks";

const wrap = (client: ReturnType<typeof createQueryClient>) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

describe("the query cache", () => {
  it("shows cached data at once and refreshes it quietly", async () => {
    const client = createQueryClient();
    client.setQueryData(["task", "list"], ["cached"], { updatedAt: 0 });
    let finish = (_: string[]) => {};
    const fetch = () => new Promise<string[]>((r) => { finish = r; });
    const { result } = renderHook(() => useEntityQuery("task", ["list"], fetch), { wrapper: wrap(client) });
    expect(result.current.data).toEqual(["cached"]);
    expect(result.current.isPending).toBe(false);
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data).toEqual(["cached"]);
    act(() => finish(["fresh"]));
    await waitFor(() => expect(result.current.data).toEqual(["fresh"]));
  });

  it("does not retry a refusal, and retries a server error", () => {
    const retry = createQueryClient().getDefaultOptions().queries!.retry as (n: number, e: unknown) => boolean;
    expect(retry(0, { status: 401 })).toBe(false);
    expect(retry(0, { status: 404 })).toBe(false);
    expect(retry(0, { status: 503 })).toBe(true);
    expect(retry(2, { status: 503 })).toBe(false);
  });

  it("keeps a pending write through a fetch that started before the server had it", async () => {
    const client = createQueryClient();
    const fetch = vi.fn(() => Promise.resolve([{ id: 1, status: "open" }]));
    const { result } = renderHook(() => useEntityQuery("task", [], fetch), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    act(() => applyEntityEvent(client, { type: "write", writeId: "w", changes: [{ entity: "task", id: 1, patch: { status: "done" } }] }));
    await act(() => client.refetchQueries({ queryKey: ["task"] }));
    expect(fetch).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data![0].status).toBe("done"));
  });
});

it("a draft survives a remount, and is the person's own", () => {
  localStorage.clear();
  const first = renderHook(() => useDraft(1, "comment"));
  act(() => first.result.current[1]("Half a thought"));
  first.unmount();
  expect(renderHook(() => useDraft(1, "comment")).result.current[0]).toBe("Half a thought");
  expect(renderHook(() => useDraft(2, "comment")).result.current[0]).toBe("");
});

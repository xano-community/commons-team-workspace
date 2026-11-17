import { describe, expect, it } from "vitest";
import { openingOffset } from "@/components/workspace/message-list";
import type { ListItem, Row } from "./log";

const message = (key: string, grouped = false): ListItem => ({ kind: "message", key, grouped, row: {} as Row });

describe("where a conversation opens", () => {
  // Estimates: a line 32, a message 52, a grouped message 24.
  const items: ListItem[] = [{ kind: "beginning", key: "beginning" }, message("a"), message("b", true), { kind: "unread", key: "unread" }, message("c"), message("d", true)];

  it("opens one screen above the end, so the first render draws the newest rows", () => {
    expect(openingOffset(items, null, 100)).toBe(32 + 52 + 24 + 32 + 52 + 24 - 100);
  });

  it("opens at the top when everything fits on one screen", () => {
    expect(openingOffset(items, null, 800)).toBe(0);
  });

  it("opens at the unread line when there is one", () => {
    expect(openingOffset(items, "unread", 100)).toBe(32 + 52 + 24);
    expect(openingOffset(items, "gone", 100)).toBe(openingOffset(items, null, 100));
  });
});

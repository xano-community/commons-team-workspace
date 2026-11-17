import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { LinkChip } from "@/components/workspace/link-chip";
import { MentionWarning } from "@/components/workspace/mention-warning";
import type { RecordView } from "./resolver";

const view = (extra: Partial<RecordView>): RecordView => ({ type: "conversation", id: 1, state: "live", title: "Launch", href: "/chat/1", can_restore: false, ...extra });
const chip = (v: RecordView, onRestore?: () => void) => render(<MemoryRouter><LinkChip view={v} onRestore={onRestore} /></MemoryRouter>);
afterEach(cleanup);

describe("a link chip", () => {
  it("shows a live record's name and opens it", () => {
    chip(view({}));
    expect(screen.getByRole("link", { name: "Launch" }).getAttribute("href")).toBe("/chat/1");
  });
  it("shows no name and no way in when locked", () => {
    chip(view({ state: "locked", title: "", href: "" }));
    expect(screen.getByText("No access")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("reads Deleted, with Restore only when it's allowed", () => {
    const restore = vi.fn();
    chip(view({ state: "deleted", title: "", href: "", can_restore: true }), restore);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(restore).toHaveBeenCalled();
    cleanup();
    chip(view({ state: "deleted", title: "", href: "" }), restore);
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });
  it("tags an archived record, which still opens", () => {
    chip(view({ state: "archived" }));
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/chat/1");
  });
  it("marks a deleted message", () => {
    chip(view({ state: "tombstone", title: "", href: "" }));
    expect(screen.getByText("Message deleted")).toBeTruthy();
  });
});

const check = { warn: true, missing: [{ id: 1, name: "Ana", kind: "human" as const }, { id: 2, name: "Ben", kind: "human" as const }], add: [{ space_id: 9, user_ids: [1, 2] }] };
const post = async () => ({ added: true, warning: null });

describe("the mention warning", () => {
  it("names who can't see it, and offers all three ways on for a manager", () => {
    render(<MentionWarning check={check} addMember={post} onProceed={() => {}} onRemove={() => {}} onAdded={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Ana and Ben");
    for (const name of ["Add to space", "Remove mention", "Send anyway"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });
  it("offers no add to someone who can't manage the space", () => {
    render(<MentionWarning check={{ ...check, add: [] }} addMember={post} onProceed={() => {}} onRemove={() => {}} onAdded={() => {}} />);
    expect(screen.queryByRole("button", { name: "Add to space" })).toBeNull();
  });
  it("in a body it follows the mention, so there's nothing to send", () => {
    render(<MentionWarning variant="notice" check={check} addMember={post} onProceed={() => {}} onRemove={() => {}} onAdded={() => {}} />);
    expect(screen.queryByRole("button", { name: "Send anyway" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep mention" })).toBeTruthy();
  });
  it("adds them, then says it's done", async () => {
    const added = vi.fn();
    render(<MentionWarning check={check} addMember={post} onProceed={() => {}} onRemove={() => {}} onAdded={added} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to space" }));
    await vi.waitFor(() => expect(added).toHaveBeenCalled());
  });
  it("shows a failed add in place", async () => {
    render(<MentionWarning check={check} addMember={async () => { throw new Error("Only this space's managers can do that."); }} onProceed={() => {}} onRemove={() => {}} onAdded={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to space" }));
    expect(await screen.findByText("Only this space's managers can do that.")).toBeTruthy();
  });
});

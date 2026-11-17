import { describe, expect, it, vi } from "vitest";
import type { SpaceList } from "@/lib/api";
import { PRIVATE_SPACE_LABEL, addSpaceMember, mySpaces, spaceHref, spaceSection } from "./spaces";

const space = (id: number, name: string, archived_at: number | null = null) =>
  ({ id, name, archived_at, created_at: 0, visibility: "open", guests_can_create: false, created_by: 1, is_demo: false }) as SpaceList["spaces"][number];
const list: SpaceList = {
  spaces: [space(1, "Launch"), space(2, "Open, not joined"), space(3, "Old", 1)],
  memberships: [{ space_id: 1, role: "member" }, { space_id: 3, role: "member" }],
};

describe("adding someone to a space", () => {
  const warned = { added: false, warning: "They'll see everything already in this space." };
  it("adds a member at once, with no warning and no history_ok", async () => {
    const post = vi.fn().mockResolvedValue({ added: true, warning: null });
    const confirm = vi.fn();
    expect(await addSpaceMember(post, confirm)).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows a guest's history warning, then sends history_ok", async () => {
    const post = vi.fn().mockResolvedValueOnce(warned).mockResolvedValueOnce({ added: true, warning: null });
    const confirm = vi.fn().mockResolvedValue(true);
    expect(await addSpaceMember(post, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledWith(warned.warning);
    expect(post).toHaveBeenLastCalledWith(true);
  });

  it("sends nothing more if the warning is turned down", async () => {
    const post = vi.fn().mockResolvedValue(warned);
    expect(await addSpaceMember(post, () => Promise.resolve(false))).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

it("a private space says admins can see it, and an open one says nothing", () => {
  const items = spaceSection({ spaces: [{ ...space(1, "Board"), visibility: "private" }, space(2, "Launch")], memberships: [{ space_id: 1, role: "member" }, { space_id: 2, role: "member" }] }, null, false, () => {}).items;
  expect(items[0].mark?.label).toBe(PRIVATE_SPACE_LABEL);
  expect(PRIVATE_SPACE_LABEL).toBe("Admins can see this space");
  expect(items[1].mark).toBeUndefined();
});

describe("the Spaces section", () => {
  it("lists the spaces this person is in, leaving out open ones and archived ones", () => {
    expect(mySpaces(list).map((s) => s.name)).toEqual(["Launch"]);
  });

  it("marks the scoped space, and has no items while empty", () => {
    const choose = vi.fn();
    const item = spaceSection(list, 1, false, choose).items[0];
    expect(item).toMatchObject({ label: "Launch", active: true });
    item.onSelect!();
    expect(choose).toHaveBeenCalledWith(1);
    expect(spaceSection(undefined, null, true, choose)).toMatchObject({ key: "spaces", loading: true, items: [] });
  });

  it("scopes the current tool, keeps its filters, and clears on a second choice", () => {
    expect(spaceHref("/tasks", "?status=open&page=3", 4)).toBe("/tasks?status=open&space=4");
    expect(spaceHref("/tasks", "?space=4", 4)).toBe("/tasks");
  });
});

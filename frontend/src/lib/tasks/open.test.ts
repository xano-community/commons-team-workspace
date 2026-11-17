import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { taskFromLists } from "./client";

const page = (rows: object[]) => ({ items: rows, totals: {}, ever: rows.length, open: rows.length, limit: 100, space_name: "", archived: false });

describe("opening a task from its list", () => {
  it("shows the row the list already holds, from any list on hand", () => {
    const client = new QueryClient();
    client.setQueryData(["task", "list", { status: "todo" }], page([{ id: 3, title: "Import final bike specs", status: "todo", project_name: "Website relaunch" }]));
    client.setQueryData(["task", "list", {}], page([{ id: 7, title: "Fix login", status: "in_review", project_name: "Website relaunch" }]));
    expect(taskFromLists(client, 7)).toMatchObject({ id: 7, title: "Fix login", status: "in_review", project_name: "Website relaunch" });
  });
  it("claims no rights and no thread until the task itself loads", () => {
    const client = new QueryClient();
    client.setQueryData(["task", "list", {}], page([{ id: 7, title: "Fix login" }]));
    expect(taskFromLists(client, 7)).toMatchObject({ can_edit: false, can_restore: false, thread_id: 0 });
  });
  it("has nothing for a task no list holds", () => {
    const client = new QueryClient();
    client.setQueryData(["task", "details", 7], { id: 7, title: "Not a list" });
    expect(taskFromLists(client, 7)).toBeUndefined();
  });
});

describe("the sheet's first look", () => {
  it("names the task's space from the setup on hand, before the task loads", () => {
    const client = new QueryClient();
    client.setQueryData(["task", "list", {}], page([{ id: 7, title: "Fix login", space_id: 2 }]));
    client.setQueryData(["project", "setup"], { spaces: [{ id: 2, name: "Marlow relaunch" }], projects: [], views: [] });
    expect(taskFromLists(client, 7)?.space_name).toBe("Marlow relaunch");
  });
  it("leaves the space blank when no setup is on hand", () => {
    const client = new QueryClient();
    client.setQueryData(["task", "list", {}], page([{ id: 7, title: "Fix login", space_id: 2 }]));
    expect(taskFromLists(client, 7)?.space_name).toBe("");
  });
});

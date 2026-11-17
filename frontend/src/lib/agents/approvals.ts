// How an approval reads, apart from how it looks. Plain words a person can decide on: what will happen, where, and who'll see it.
import type { ApprovalView } from "../../../../xano/query/agents.js";

export type { ApprovalView };
export type Fact = { label: string; value: string };
export type ApprovalLook = {
  /** The rest of the sentence after the agent's name. The record, when there is one, comes straight after it. */
  asks: string;
  /** The exact words at stake, shown whole: this is what the person is agreeing to. */
  body: string;
  /** What the body is, for a screen reader and for the box you edit it in. */
  bodyLabel: string;
  /** The agent's own reason, when the body is something else. */
  reason: string;
  facts: Fact[];
  /** What it says once it went through. */
  done: string;
};

const text = (d: ApprovalView["details"], key: string) => { const v = d?.[key]; return typeof v === "string" ? v : ""; };
const number = (d: ApprovalView["details"], key: string) => { const v = d?.[key]; return typeof v === "number" ? v : 0; };
const taskIds = (d: ApprovalView["details"]) => (Array.isArray(d?.ids) ? d.ids.length : 0);
const dropEmpty = (facts: Fact[]) => facts.filter((f) => f.value);
const WORDS = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function approvalLook(v: ApprovalView, nameOf: (id: number) => string): ApprovalLook {
  const d = v.details;
  const person = (key: string) => { const id = number(d, key); return id ? nameOf(id) : ""; };
  const plain = { body: "", bodyLabel: "", reason: v.preview, facts: [] as Fact[] };
  switch (v.action) {
    case "send_external":
      return { ...plain, asks: "wants to post in", body: text(d, "body"), bodyLabel: "The message", reason: "", done: "Posted" };
    case "send_dm":
      return { ...plain, asks: `wants to message ${person("member_id") || "someone"}, from`, body: text(d, "body"), bodyLabel: "The message", reason: "", done: "Sent" };
    case "save_task":
      return {
        ...plain, asks: number(d, "id") ? "wants to change" : "wants to add a task to", body: text(d, "title"), bodyLabel: "The task's title", reason: "", done: "Task saved",
        facts: dropEmpty([{ label: "Description", value: text(d, "description") }, { label: "Status", value: WORDS(text(d, "status")) }, { label: "Priority", value: WORDS(text(d, "priority")) }, { label: "Due", value: text(d, "due_on") }, { label: "Assigned to", value: person("assignee_id") }]),
      };
    case "save_doc":
      return {
        ...plain, asks: number(d, "id") ? "wants to change" : "wants to start a doc in", body: text(d, "text"), bodyLabel: number(d, "id") ? "The new words" : "The doc's text", reason: text(d, "note"), done: "Doc saved",
        facts: dropEmpty([{ label: "Title", value: text(d, "title") }, { label: "Replaces", value: text(d, "find") }]),
      };
    case "save_file":
      return { ...plain, asks: "wants to add a file to", body: text(d, "name"), bodyLabel: "The file's name", reason: "", done: "File saved", facts: dropEmpty([{ label: "It starts", value: v.preview }]) };
    case "save_crm_record":
      return { ...plain, asks: "wants to link a customer to", reason: text(d, "note"), done: "Saved and linked", facts: dropEmpty([{ label: "Customer", value: v.preview }]) };
    case "delete_record":
      return { ...plain, asks: "wants to delete", done: "Moved to the trash" };
    case "bulk_change":
      return {
        ...plain, asks: `wants to change ${taskIds(d)} tasks in`, done: "Changed",
        facts: dropEmpty([{ label: "Status", value: WORDS(text(d, "status")) }, { label: "Priority", value: WORDS(text(d, "priority")) }, { label: "Assigned to", value: person("assignee_id") }]),
      };
    case "export_crm":
      return { ...plain, asks: "wants to export every company and contact to a file", done: "Exported" };
    case "grant_space_access":
      return { ...plain, asks: "wants to join", done: "Added to the space" };
    case "change_role":
      return { ...plain, asks: "wants to change a role:", body: text(d, "role"), bodyLabel: "The new role", facts: dropEmpty([{ label: "For", value: person("id") }]), done: "Role changed" };
    default:
      return { ...plain, asks: v.title ? `wants to: ${v.title}` : "wants your OK", done: "Done" };
  }
}

/**
 * Where it lands, named the way people say it: a post into a thread reads "wants to reply in a thread in" #channel, with the chip
 * naming the channel and still opening the thread. Anything else keeps its sentence and its record as they are.
 */
export function landing<R extends { title: string }>(action: string, asks: string, record: R | null): { asks: string; record: R | null } {
  const channel = record?.title.match(/^Thread in #?(.+)$/)?.[1];
  if (action === "send_external" && record && channel) return { asks: "wants to reply in a thread in", record: { ...record, title: channel } };
  return { asks, record };
}

/** Who outside the team reads this, by name, because that's what the decision is about. */
export function audienceLine(guests: string[]): string {
  if (!guests.length) return "";
  if (guests.length === 1) return `${guests[0]} will see this. They're a guest here.`;
  if (guests.length === 2) return `${guests[0]} and ${guests[1]} will see this. They're guests here.`;
  return `${guests[0]}, ${guests[1]} and ${guests.length - 2} more will see this. They're guests here.`;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** How long until nobody can decide. The last day counts in hours, because that's when it matters. */
export function expiresLine(expiresAt: number | null, now: number): string {
  if (!expiresAt) return "";
  const left = expiresAt - now;
  if (left <= 0) return "";
  if (left < HOUR) return "Expires within the hour";
  if (left < DAY) { const h = Math.round(left / HOUR); return `Expires in ${h} ${h === 1 ? "hour" : "hours"}`; }
  const d = Math.round(left / DAY);
  return `Expires in ${d} ${d === 1 ? "day" : "days"}`;
}

/** What a settled card says. Nothing about an approved one is hedged, and a refused one says nothing happened. */
export function outcomeLine(v: Pick<ApprovalView, "status" | "agent_name" | "decided_by_name">, look: Pick<ApprovalLook, "done">): string {
  if (v.status === "approved") return `${look.done}. ${v.agent_name} · approved by ${v.decided_by_name ?? "a person"}`;
  if (v.status === "declined") return `Declined${v.decided_by_name ? ` by ${v.decided_by_name}` : ""}. Nothing happened, and ${v.agent_name} has been told.`;
  if (v.status === "expired") return `Nobody decided in time, so nothing happened. ${v.agent_name} has been told.`;
  return "";
}

/** The line someone who reaches the record sees when the decision isn't theirs. */
export const waitingLine = (v: Pick<ApprovalView, "agent_name" | "waiting_for">) => `${v.agent_name} is waiting for ${v.waiting_for} to approve something here.`;

/** Blank means no change, and the box starts as the agent wrote it, so only a real edit is sent. */
export const editedValue = (draft: string, original: string) => (draft !== original ? draft : undefined);

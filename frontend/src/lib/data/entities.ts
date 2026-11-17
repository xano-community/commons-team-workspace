// The one place cached records change. A local optimistic write, its rollback, the server's answer and a live event
// from another person all pass through applyEntityEvent(), so a screen never has two ways of being updated.
//
// Query keys start with the entity: ["task"], ["task", id], ["task", { project: 3 }]. The cache lives in memory only.
// The live server sends ids, never rows, so a remote event usually means "refetch what this person may see".
import type { QueryClient } from "@tanstack/react-query";

export type EntityId = number | string;
export type EntityPatch = Record<string, unknown>;
/** One record's change inside a write. A write may touch several: a task's status and its project's count. */
export type EntityChange = {
  entity: string; id: EntityId; patch: EntityPatch;
  /** A new record: it joins each list it fits, and leaves again if the write fails. `id` is a stand-in until the server answers. */
  insert?: boolean;
};

export type EntityEvent =
  /** This person's optimistic change. It stays pending until `settled` or `failed`. */
  | { type: "write"; writeId: string; changes: EntityChange[] }
  /** The server accepted the write. `rows` are its answer, if it sent any. */
  | { type: "settled"; writeId: string; rows?: EntityChange[] }
  /** The server refused the write: put back only what it changed. */
  | { type: "failed"; writeId: string }
  /** Someone changed a record, or `id: null` for many. `entity: "*"` means anything may have changed. */
  | { type: "remote"; entity: string; id: EntityId | null; op?: string; patch?: EntityPatch };

type Pending = { writeId: string; changes: EntityChange[]; prior: Map<string, EntityPatch> };
type Ledger = { writes: Map<string, Pending>; deferred: Set<string> };

const ledgers = new WeakMap<QueryClient, Ledger>();
const ledgerOf = (client: QueryClient): Ledger => {
  let l = ledgers.get(client);
  if (!l) { l = { writes: new Map(), deferred: new Set() }; ledgers.set(client, l); }
  return l;
};
const recordKey = (entity: string, id: EntityId) => `${entity}:${id}`;
const isRecord = (v: unknown): v is { id: EntityId } & EntityPatch =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "id" in v;

/** Calls `edit` on the record with this id, wherever the query holds it: alone, in an array, or in a page's `items`. */
function mapRecord(data: unknown, id: EntityId, edit: (r: EntityPatch) => EntityPatch | null): unknown {
  if (Array.isArray(data)) {
    let changed = false;
    const next: unknown[] = [];
    for (const row of data) {
      if (isRecord(row) && row.id === id) {
        changed = true;
        const out = edit(row);
        if (out) next.push(out);
      } else next.push(row);
    }
    return changed ? next : data;
  }
  if (isRecord(data)) return data.id === id ? edit(data) ?? undefined : data;
  if (typeof data === "object" && data !== null && Array.isArray((data as { items?: unknown }).items)) {
    const page = data as { items: unknown[] };
    const items = mapRecord(page.items, id, edit);
    return items === page.items ? data : { ...page, items };
  }
  return data;
}

function findRecord(client: QueryClient, entity: string, id: EntityId): EntityPatch | undefined {
  for (const [, data] of client.getQueriesData({ queryKey: [entity] })) {
    let found: EntityPatch | undefined;
    mapRecord(data, id, (r) => { found = r; return r; });
    if (found) return found;
  }
  return undefined;
}

type Page = { items: unknown[] };
const isPage = (data: unknown): data is Page => typeof data === "object" && data !== null && Array.isArray((data as Page).items);
/** Whether a new record belongs in a list. A list's key ends in what it asked for, under the record's own field names. */
const fits = (key: readonly unknown[], row: EntityPatch) => {
  const asked = key.at(-1);
  if (typeof asked !== "object" || asked === null) return true;
  return Object.entries(asked).every(([k, v]) => !(k in row) || v === undefined || v === "" || row[k] === v);
};
const withRow = (data: unknown, row: EntityPatch) => (isPage(data) && !data.items.some((r) => isRecord(r) && r.id === row.id) ? { ...data, items: [...data.items, row] } : data);
function insertInto(client: QueryClient, entity: string, row: EntityPatch) {
  for (const query of client.getQueryCache().findAll({ queryKey: [entity] })) {
    if (fits(query.queryKey, row)) client.setQueryData(query.queryKey, (data: unknown) => withRow(data, row));
  }
}

const patchCache = (client: QueryClient, entity: string, id: EntityId, patch: EntityPatch) =>
  client.setQueriesData({ queryKey: [entity] }, (data: unknown) => mapRecord(data, id, (r) => ({ ...r, ...patch })));
const removeFromCache = (client: QueryClient, entity: string, id: EntityId) =>
  client.setQueriesData({ queryKey: [entity] }, (data: unknown) => mapRecord(data, id, () => null));
const refetch = (client: QueryClient, entity: string) =>
  void client.invalidateQueries(entity === "*" ? undefined : { queryKey: [entity] });

/** The fields writes still in flight hold for this record, newest last. */
function pendingFields(ledger: Ledger, entity: string, id: EntityId): EntityPatch {
  const out: EntityPatch = {};
  for (const w of ledger.writes.values()) {
    for (const c of w.changes) if (c.entity === entity && c.id === id) Object.assign(out, c.patch);
  }
  return out;
}
/** A record still being created holds a refetch back too: the list would show it twice, once under each id. */
const hasPending = (ledger: Ledger, entity: string, id: EntityId | null) =>
  [...ledger.writes.values()].some((w) => w.changes.some((c) => (entity === "*" || c.entity === entity) && (id === null || c.id === id || c.insert)));

/** Refetches anything a pending write was holding back, once nothing is pending on it. */
function flushDeferred(client: QueryClient, ledger: Ledger) {
  for (const entity of [...ledger.deferred]) {
    if (hasPending(ledger, entity, null)) continue;
    ledger.deferred.delete(entity);
    refetch(client, entity);
  }
}

function applyWrite(client: QueryClient, ledger: Ledger, writeId: string, changes: EntityChange[]) {
  if (ledger.writes.has(writeId)) return;   // a held write being sent again: it's already on screen
  const prior = new Map<string, EntityPatch>();
  for (const c of changes) {
    void client.cancelQueries({ queryKey: [c.entity] });
    if (c.insert) { insertInto(client, c.entity, c.patch); continue; }
    const before = findRecord(client, c.entity, c.id);
    if (before) prior.set(recordKey(c.entity, c.id), Object.fromEntries(Object.keys(c.patch).map((k) => [k, before[k]])));
    patchCache(client, c.entity, c.id, c.patch);
  }
  ledger.writes.set(writeId, { writeId, changes, prior });
}

function rollback(client: QueryClient, ledger: Ledger, write: Pending) {
  for (const c of write.changes) {
    ledger.deferred.add(c.entity);   // the server has the last word, and a record loaded since may have no prior value
    if (c.insert) { removeFromCache(client, c.entity, c.id); continue; }
    const prior = write.prior.get(recordKey(c.entity, c.id));
    if (!prior) continue;
    // A newer write to the same field keeps its value: this rollback undoes its own change and nothing else.
    const held = pendingFields(ledger, c.entity, c.id);
    const restore = Object.fromEntries(Object.entries(prior).filter(([k]) => !(k in held)));
    patchCache(client, c.entity, c.id, restore);
  }
}

export function applyEntityEvent(client: QueryClient, event: EntityEvent): void {
  const ledger = ledgerOf(client);
  switch (event.type) {
    case "write":
      applyWrite(client, ledger, event.writeId, event.changes);
      return;
    case "settled": {
      const write = ledger.writes.get(event.writeId);
      ledger.writes.delete(event.writeId);
      for (const row of event.rows ?? []) {
        const held = pendingFields(ledger, row.entity, row.id);
        patchCache(client, row.entity, row.id, Object.fromEntries(Object.entries(row.patch).filter(([k]) => !(k in held))));
      }
      if (!event.rows?.length) for (const c of write?.changes ?? []) ledger.deferred.add(c.entity);
      flushDeferred(client, ledger);
      return;
    }
    case "failed": {
      const write = ledger.writes.get(event.writeId);
      if (!write) return;
      ledger.writes.delete(event.writeId);
      rollback(client, ledger, write);
      flushDeferred(client, ledger);
      return;
    }
    case "remote": {
      const { entity, id, op, patch } = event;
      // A remote row never lands on a field this person is still writing; the rest of it does.
      if (patch && id !== null) {
        const held = pendingFields(ledger, entity, id);
        patchCache(client, entity, id, Object.fromEntries(Object.entries(patch).filter(([k]) => !(k in held))));
      }
      if (hasPending(ledger, entity, id)) { ledger.deferred.add(entity); return; }
      if (op === "deleted" && id !== null) removeFromCache(client, entity, id);
      if (!patch) refetch(client, entity);
    }
  }
}

/** A fresh fetch must not undo a write still in flight, so its answer is read through the pending changes. */
export function withPending<T>(client: QueryClient, entity: string, data: T): T {
  const ledger = ledgerOf(client);
  let out: unknown = data;
  for (const w of ledger.writes.values()) {
    for (const c of w.changes) {
      if (c.entity === entity) out = c.insert ? withRow(out, c.patch) : mapRecord(out, c.id, (r) => ({ ...r, ...c.patch }));
    }
  }
  return out as T;
}

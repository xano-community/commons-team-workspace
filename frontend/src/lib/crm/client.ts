// How the customer screens read and write. Reads come through the query cache, which a frame on the `crm` channel refreshes. Each
// write shows at once, goes through the outbox, and takes the server's row as its answer, so a refusal rolls back by name.
import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLive } from "@/base/live";
import { request } from "@/base/request";
import { useMe } from "@/base/session";
import { useEntityQuery, useWrite } from "@/lib/data";
import { shellToast } from "@/lib/toast";
import { routePath } from "../../../../xano/routes.gen.js";
import { crmApi } from "./api";
import type { CompanyDetails, CompanyView, DealDetails, DealView, NoteView, PipelineRequest, Stage } from "./model";
import { dealsIn, dropDeal, GAP, type DealMove } from "./order";
import { companyPatch, dealPatch, insertDeal, moveLabel, standIn } from "./writes";

/** A deal and what surrounds it, as one record, so a write or a live change reaches it like any other copy. */
export type DealFull = DealView & Omit<DealDetails, "deal">;
export type CompanyFull = CompanyView & Omit<CompanyDetails, "company">;
export type Owner = { id: number; name: string; kind: "human" | "agent" } | null;
export type NewDeal = { company_id: number; company_name: string; title: string; stage: Stage; value: number; close_on: string; owner: Owner; contact_id: number };

export const useCrmSetup = (enabled = true) => useEntityQuery("pipeline_stage", ["setup"], crmApi.setup, { enabled });
/** What's cached shows at once. A change that came while this screen was closed had nobody listening, so it refreshes behind. */
export const usePipeline = (request: PipelineRequest, enabled = true) => useEntityQuery("deal", ["pipeline", request], () => crmApi.pipeline(request), { refetchOnMount: "always", enabled });
export const useCompanies = (q: { q?: string; owner_id?: number; page?: number }, enabled = true) => {
  const page = useEntityQuery("company", ["list", q], () => crmApi.companies(q), { refetchOnMount: "always", enabled });
  useLive(["deal", "contact"], () => void page.refetch());
  return page;
};
export const useContacts = (q: { q?: string; page?: number }, enabled = true) => useEntityQuery("contact", ["list", q], () => crmApi.contacts(q), { refetchOnMount: "always", enabled });

/** A page shows records from all over, so anything that can change what's on it refreshes it. */
const AROUND_A_RECORD = ["deal", "contact", "crm_note", "record_link", "task", "doc", "conversation"];
export function useCompanyDetails(id: number) {
  const details = useEntityQuery("company", ["details", id], async (): Promise<CompanyFull> => { const { company, ...rest } = await crmApi.company(id); return { ...company, ...rest }; });
  useLive(AROUND_A_RECORD, () => void details.refetch());
  return details;
}
export function useDealDetails(id: number) {
  const details = useEntityQuery("deal", ["details", id], async (): Promise<DealFull> => { const { deal, ...rest } = await crmApi.deal(id); return { ...deal, ...rest }; });
  useLive(["contact", "crm_note", "pipeline_stage"], () => void details.refetch());
  return details;
}
export const usePanels = (id: number, limit: number, enabled: boolean) => {
  const panels = useEntityQuery("company", ["panels", id, limit], () => crmApi.panels(id, limit), { enabled });
  useLive(AROUND_A_RECORD, () => { if (enabled) void panels.refetch(); });
  return panels;
};

/** The one way anything changes a deal or a company. `rows` are what's on screen, for working out where a move lands. */
export function useCrmActions() {
  const me = useMe()!;
  const write = useWrite(me.id);
  return useMemo(() => {
    const onDeal = (deal: DealView, label: string, route: "stage" | "move" | "owner", body: object, patch: Record<string, unknown>) => write({
      label, verb: "POST", answer: true, changes: [dealPatch(deal.id, patch)], body, path: routePath(`POST deals/{id}/${route}` as "POST deals/{id}/stage", { id: deal.id }),
    });
    const closing = (deal: DealView, stage: Pick<Stage, "kind">) => (stage.kind === "open" ? null : deal.closed_at ?? Date.now());
    const actions = {
      /** To the top of a stage, from a menu, wherever the rest of it is. */
      setStage: (deal: DealView, stage: Stage, rows: DealView[]) => {
        if (deal.stage_id === stage.id) return;
        const top = dealsIn(rows, stage.id)[0]?.rank;
        return onDeal(deal, moveLabel(deal.title, stage.name), "stage", { stage_id: stage.id }, { stage_id: stage.id, stage_name: stage.name, stage_kind: stage.kind, rank: top === undefined ? 0 : top - GAP, closed_at: closing(deal, stage) });
      },
      move: (deal: DealView, m: DealMove, stage: Stage) => onDeal(deal, moveLabel(deal.title, stage.name), "move", { stage_id: m.stage_id, before_id: m.before_id }, { stage_id: m.stage_id, stage_name: stage.name, stage_kind: stage.kind, rank: m.rank, closed_at: closing(deal, stage) }),
      drop: (deal: DealView, stage: Stage, before: number | null, rows: DealView[]) => actions.move(deal, dropDeal(rows, deal.id, stage.id, before), stage),
      assign: (deal: DealView, owner: Owner) => {
        if ((deal.owner_id || 0) === (owner?.id ?? 0)) return;
        void onDeal(deal, owner ? `give ${deal.title} to ${owner.name}` : `take the owner off ${deal.title}`, "owner", { owner_id: owner?.id ?? 0 }, { owner_id: owner?.id ?? 0, owner_name: owner?.name ?? null, owner_kind: owner?.kind ?? null });
      },
      update: (deal: DealView, fields: { title: string; value: number; close_on: string; contact_id: number }) => write({
        label: `save ${fields.title || deal.title}`, verb: "PATCH", path: routePath("PATCH deals/{id}", { id: deal.id }), body: fields, answer: true, changes: [dealPatch(deal.id, { ...fields, close_on: fields.close_on || null })],
      }),
      setClose: (deal: DealView, close_on: string) => {
        if ((deal.close_on ?? "") === close_on) return;
        return actions.update(deal, { title: deal.title, value: deal.value, close_on, contact_id: deal.contact_id });
      },
      removeDeal: async (deal: DealView) => {
        const ended = await write({ label: `delete ${deal.title}`, verb: "DELETE", path: routePath("DELETE deals/{id}", { id: deal.id }), changes: [dealPatch(deal.id, { deleted_at: Date.now() })] });
        if (ended === "sent") shellToast.show(`Deleted ${deal.title}`, { label: "Undo", onClick: () => void actions.restoreDeal(deal) });
        return ended;
      },
      restoreDeal: (deal: DealView) => write({ label: `restore ${deal.title}`, verb: "POST", path: routePath("POST deals/{id}/restore", { id: deal.id }), body: {}, answer: true, changes: [dealPatch(deal.id, { deleted_at: null })] }),
      createDeal: (d: NewDeal, rows: DealView[]) => {
        const top = dealsIn(rows, d.stage.id)[0]?.rank;
        const row = {
          id: standIn(), company_id: d.company_id, company_name: d.company_name, contact_id: d.contact_id, contact_name: null, title: d.title, stage_id: d.stage.id, stage_name: d.stage.name, stage_kind: d.stage.kind, value: d.value, close_on: d.close_on || null,
          owner_id: d.owner?.id ?? 0, owner_name: d.owner?.name ?? null, owner_kind: d.owner?.kind ?? null, rank: top === undefined ? 0 : top - GAP, closed_at: null, deleted_at: null,
        };
        return write({
          label: `add ${d.title}`, verb: "POST", path: routePath("POST deals"), answer: true, changes: [insertDeal(row)],
          body: { client_id: crypto.randomUUID(), company_id: d.company_id, stage_id: d.stage.id, title: d.title, value: d.value, close_on: d.close_on, owner_id: d.owner?.id ?? 0, contact_id: d.contact_id },
        });
      },
      updateCompany: (company: CompanyView, fields: { name: string; domain: string; industry: string; about: string }) => write({
        label: `save ${fields.name || company.name}`, verb: "PATCH", path: routePath("PATCH companies/{id}", { id: company.id }), body: fields, answer: true, changes: [companyPatch(company.id, fields)],
      }),
      assignCompany: (company: CompanyView, owner: Owner) => {
        if ((company.owner_id || 0) === (owner?.id ?? 0)) return;
        void write({
          label: owner ? `give ${company.name} to ${owner.name}` : `take the owner off ${company.name}`, verb: "POST", path: routePath("POST companies/{id}/owner", { id: company.id }), body: { owner_id: owner?.id ?? 0 }, answer: true,
          changes: [companyPatch(company.id, { owner_id: owner?.id ?? 0, owner_name: owner?.name ?? null, owner_kind: owner?.kind ?? null })],
        });
      },
      removeCompany: async (company: CompanyView) => {
        const ended = await write({ label: `delete ${company.name}`, verb: "DELETE", path: routePath("DELETE companies/{id}", { id: company.id }), changes: [companyPatch(company.id, { deleted_at: Date.now() })] });
        if (ended === "sent") shellToast.show(`Deleted ${company.name}, with its contacts and deals`, { label: "Undo", onClick: () => void actions.restoreCompany(company) });
        return ended;
      },
      restoreCompany: (company: CompanyView) => write({ label: `restore ${company.name}`, verb: "POST", path: routePath("POST companies/{id}/restore", { id: company.id }), body: {}, answer: true, changes: [companyPatch(company.id, { deleted_at: null })] }),
    };
    return actions;
  }, [write]);
}

export type ContactFields = { name: string; email: string; phone: string; job_title: string };

/** A contact sits on its company's page, so a change refreshes that. A refusal stays in the dialog, with the words as they were typed. */
export function useContactActions() {
  const client = useQueryClient();
  return useMemo(() => {
    const settle = () => Promise.all([client.invalidateQueries({ queryKey: ["contact"] }), client.invalidateQueries({ queryKey: ["company"] })]);
    const restore = (id: number, name: string) => request("POST", routePath("POST contacts/{id}/restore", { id }), {}).then(settle, (e: unknown) => shellToast.error(`Couldn't restore ${name}. ${e instanceof Error ? e.message : "Try again."}`));
    return {
      create: async (company_id: number, f: ContactFields) => { await crmApi.createContact({ client_id: crypto.randomUUID(), company_id, ...f }); await settle(); },
      update: async (id: number, f: ContactFields) => { await crmApi.updateContact(id, f); await settle(); },
      remove: async (id: number, name: string) => {
        await request("DELETE", routePath("DELETE contacts/{id}", { id }));
        await settle();
        shellToast.show(`Deleted ${name}`, { label: "Undo", onClick: () => void restore(id, name) });
      },
    };
  }, [client]);
}

type Subject = { type: "company" | "contact" | "deal"; id: number };

/** Notes sit inside their record's answer, so they're written here, against every copy of it on screen. */
export function useNoteActions(detailsKey: readonly unknown[]) {
  const me = useMe()!;
  const client = useQueryClient();
  const edit = useCallback((fn: (notes: NoteView[]) => NoteView[]) => client.setQueryData(detailsKey, (d: { notes: NoteView[] } | undefined) => (d ? { ...d, notes: fn(d.notes) } : d)), [client, detailsKey]);
  const settle = useCallback(() => client.invalidateQueries({ queryKey: detailsKey }), [client, detailsKey]);
  return useMemo(() => ({
    /** Answers whether it went in. A refusal takes the note back off the page, and the caller puts the words back. */
    add: async (subject: Subject, company_id: number, body: string) => {
      const temp = { id: standIn(), record_type: subject.type, record_id: subject.id, company_id, body, author_id: me.id, author_name: me.name, author_kind: "human", created_at: Date.now(), edited_at: null, deleted_at: null } as NoteView;
      edit((notes) => [temp, ...notes]);
      try {
        await crmApi.addNote({ client_id: crypto.randomUUID(), record_type: subject.type, record_id: subject.id, body });
        await settle();
        return true;
      } catch (e) {
        edit((notes) => notes.filter((n) => n.id !== temp.id));
        shellToast.error(`Couldn't add that note. ${e instanceof Error ? e.message : "Try again."}`);
        return false;
      }
    },
    edit: async (note: NoteView, body: string) => {
      edit((notes) => notes.map((n) => (n.id === note.id ? { ...n, body, edited_at: Date.now() } : n)));
      try { await crmApi.editNote(note.id, body); await settle(); return true; }
      catch (e) {
        edit((notes) => notes.map((n) => (n.id === note.id ? note : n)));
        shellToast.error(`Couldn't save that note. ${e instanceof Error ? e.message : "Try again."}`);
        return false;
      }
    },
    remove: async (note: NoteView) => {
      edit((notes) => notes.filter((n) => n.id !== note.id));
      try {
        await crmApi.deleteNote(note.id);
        await settle();
        shellToast.show("Deleted the note", { label: "Undo", onClick: () => void crmApi.restoreNote(note.id).then(settle, (e: unknown) => shellToast.error(`Couldn't restore that note. ${e instanceof Error ? e.message : "Try again."}`)) });
      } catch (e) {
        await settle();
        shellToast.error(`Couldn't delete that note. ${e instanceof Error ? e.message : "Try again."}`);
      }
    },
  }), [edit, me.id, me.name, settle]);
}

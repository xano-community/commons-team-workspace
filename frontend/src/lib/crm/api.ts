// The customer screens' requests. They load with those screens, so the shell doesn't carry them.
import { routePath } from "../../../../xano/routes.gen.js";
import { qs, request } from "@/base/request";
import type { CompanyDetails, CompanyPage, CompanyView, ContactPage, ContactView, CrmHit, CrmSetup, DealDetails, NoteView, Panels, Pipeline, PipelineRequest, Stage } from "./model";

export const crmApi = {
  setup: () => request<CrmSetup>("GET", routePath("GET crm-setup")),
  pipeline: (q: PipelineRequest) => request<Pipeline>("GET", routePath("GET pipeline") + qs(q)),
  companies: (q: { q?: string; owner_id?: number; page?: number }) => request<CompanyPage>("GET", routePath("GET companies") + qs(q)),
  contacts: (q: { q?: string; page?: number }) => request<ContactPage>("GET", routePath("GET contacts") + qs(q)),
  company: (id: number) => request<CompanyDetails>("GET", routePath("GET companies/{id}", { id })),
  panels: (id: number, limit: number) => request<Panels>("GET", routePath("GET companies/{id}/panels", { id }) + qs({ limit })),
  deal: (id: number) => request<DealDetails>("GET", routePath("GET deals/{id}", { id })),
  read: (entity: "company" | "contact" | "deal", id: number) => request<{ read: number }>("POST", routePath("POST crm-read"), { entity, id }),
  createCompany: (body: object) => request<CompanyView>("POST", routePath("POST companies"), body),
  createContact: (body: object) => request<ContactView>("POST", routePath("POST contacts"), body),
  updateContact: (id: number, body: object) => request<ContactView>("PATCH", routePath("PATCH contacts/{id}", { id }), body),
  addNote: (body: object) => request<NoteView>("POST", routePath("POST crm-notes"), body),
  editNote: (id: number, body: string) => request<NoteView>("PATCH", routePath("PATCH crm-notes/{id}", { id }), { body }),
  deleteNote: (id: number) => request<NoteView>("DELETE", routePath("DELETE crm-notes/{id}", { id })),
  restoreNote: (id: number) => request<NoteView>("POST", routePath("POST crm-notes/{id}/restore", { id }), {}),
  createStage: (name: string) => request<Stage>("POST", routePath("POST stages"), { name }),
  renameStage: (id: number, name: string) => request<Stage>("PATCH", routePath("PATCH stages/{id}", { id }), { name }),
  moveStage: (id: number, before_id: number) => request<Stage>("POST", routePath("POST stages/{id}/move", { id }), { before_id }),
  deleteStage: (id: number) => request<{ removed: boolean }>("DELETE", routePath("DELETE stages/{id}", { id })),
  search: (q: string) => request<CrmHit[]>("GET", routePath("GET crm-search") + qs({ q })),
};

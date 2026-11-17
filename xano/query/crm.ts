// Customers over HTTP. Each route is one line around its function in function/crm/, so an agent's tool runs the same rule.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import type { InferRow } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { company } from "../table/crm/company.js";
import { contact } from "../table/crm/contact.js";
import { crm_note, NOTE_RECORDS } from "../table/crm/crm_note.js";
import { deal } from "../table/crm/deal.js";
import { pipeline_stage } from "../table/crm/pipeline_stage.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser } from "../function/access/reach.js";
import { readRecordItems } from "../function/inbox/read.js";
import { assignCompany, createCompany, deleteCompany, restoreCompany, updateCompany } from "../function/crm/companies.js";
import { createContact, deleteContact, restoreContact, updateContact } from "../function/crm/contacts.js";
import { assignDeal, createDeal, deleteDeal, moveDeal, restoreDeal, setDealStage, updateDeal } from "../function/crm/deals.js";
import { addNote, crmMentionCheckFn, deleteNote, editNote, restoreNote } from "../function/crm/notes.js";
import { companyPanels, crmSetup, listCompanies, listContacts, readCompany, readDeal, readPipeline, searchCrm } from "../function/crm/reads.js";
import { createStage, deleteStage, moveStage, renameStage } from "../function/crm/stages.js";
import type { MentionCheck, RecordView } from "./links.js";

export const crmGroup = apiGroup({ name: "crm", canonical: "crm", middleware: { pre: [gateActive] }, description: "Companies, contacts, deals, the pipeline and notes." });

type Person = { id: number; name: string; kind: "human" | "agent" };
type Kind = "human" | "agent" | null;
export type Stage = InferRow<typeof pipeline_stage>;
export type CompanyView = InferRow<typeof company> & { owner_name: string | null; owner_kind: Kind };
export type CompanyRow = CompanyView & { open_deals: number; open_value: number; contacts: number };
export type ContactView = InferRow<typeof contact> & { company_name: string | null };
/** A deal as every screen reads it. A name rides along, because its person may have left the people list. */
export type DealView = InferRow<typeof deal> & { owner_name: string | null; owner_kind: Kind; company_name: string | null; contact_name: string | null; stage_name: string | null; stage_kind: Stage["kind"] | null };
export type NoteView = InferRow<typeof crm_note> & { author_name: string | null; author_kind: Kind };
export type PipelineStage = Stage & { deals: number; value: number };
export type Pipeline = { stages: PipelineStage[]; items: DealView[]; ever: number; open: number; companies: number; limit: number };
export type CrmSetup = { stages: Stage[]; people: Person[]; can_manage: boolean };
export type CompanyPage = { items: CompanyRow[]; total: number; next_page: number | null; ever: number };
export type ContactPage = { items: ContactView[]; total: number; next_page: number | null; ever: number };
export type PanelView = { items: RecordView[]; total: number };
export type Panels = { chat: PanelView; tasks: PanelView; docs: PanelView; files: PanelView };
export type CompanyDetails = { company: CompanyView; contacts: InferRow<typeof contact>[]; deals: DealView[]; notes: NoteView[]; panels: Panels; thread_id: number; unread_items: number; trashed: boolean; can_edit: boolean };
export type DealDetails = { deal: DealView; contacts: InferRow<typeof contact>[]; notes: NoteView[]; thread_id: number; unread_items: number; trashed: boolean; can_edit: boolean };
export type CrmHit = { type: "company" | "deal" | "contact"; id: number; title: string; hint: string };

const caller = () => [...rbac.signedIn(), ...bindBrowser()];
const who = () => ({ actor_id: auth("id"), browser: ref("browser") });
const text = () => input.text({ methods: ["trim"] });
const id = () => input.int({ required: true });

export const crmSetupRoute = query({
  apiGroup: crmGroup, auth: user, name: "crm-setup", verb: "GET",
  description: "The pipeline's stages, and who can own a record.",
  stack: [...caller(), s.function.run({ fn: crmSetup, as: "setup", input: who() })],
  response: ref("setup"), responseShape: {} as CrmSetup,
});

export const pipelineRoute = query({
  apiGroup: crmGroup, auth: user, name: "pipeline", verb: "GET",
  description: "The pipeline's deals, stage by stage.",
  input: { q: text(), owner_id: input.int(), company_id: input.int(), close_from: input.text(), close_to: input.text(), limit: input.int() },
  stack: [...caller(), s.function.run({ fn: readPipeline, as: "page", input: { ...who(), q: inp("q"), owner_id: inp("owner_id"), company_id: inp("company_id"), close_from: inp("close_from"), close_to: inp("close_to"), limit: inp("limit") } })],
  response: ref("page"), responseShape: {} as Pipeline,
});

export const crmSearchRoute = query({
  apiGroup: crmGroup, auth: user, name: "crm-search", verb: "GET",
  description: "Companies, deals and contacts you reach whose name matches.",
  input: { q: text() },
  stack: [...caller(), s.function.run({ fn: searchCrm, as: "found", input: { ...who(), q: inp("q") } })],
  response: ref("found"), responseShape: [] as CrmHit[],
});

export const crmMentionCheck = query({
  apiGroup: crmGroup, auth: user, name: "crm-mention-check", verb: "POST",
  description: "Whether naming these people in a note needs a warning.",
  input: { people: input.json({ required: true }) },
  stack: [...caller(), s.function.run({ fn: crmMentionCheckFn, as: "check", input: { ...who(), people: inp("people") } })],
  response: ref("check"), responseShape: {} as MentionCheck,
});

/** POST crm-read: you've opened it, so what your inbox says about it is read. */
export const crmReadRoute = query({
  apiGroup: crmGroup, auth: user, name: "crm-read", verb: "POST",
  description: "Say you've opened a company or a deal.",
  input: { entity: input.enum(NOTE_RECORDS, { required: true }), id: id() },
  stack: [...caller(), s.function.run({ fn: readRecordItems, as: "read", input: { ...who(), entity: inp("entity"), entity_id: inp("id") } })],
  response: ref("read"), responseShape: {} as { read: number },
});

export const listCompaniesRoute = query({
  apiGroup: crmGroup, auth: user, name: "companies", verb: "GET",
  description: "A page of companies.",
  input: { q: text(), owner_id: input.int(), page: input.int() },
  stack: [...caller(), s.function.run({ fn: listCompanies, as: "page", input: { ...who(), q: inp("q"), owner_id: inp("owner_id"), page: inp("page") } })],
  response: ref("page"), responseShape: {} as CompanyPage,
});

export const createCompanyRoute = query({
  apiGroup: crmGroup, auth: user, name: "companies", verb: "POST",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Add a company. Safe to retry with the same client_id.",
  input: { client_id: input.text({ required: true }), name: text(), domain: text(), industry: text(), about: text(), owner_id: input.int() },
  stack: [...caller(), s.function.run({ fn: createCompany, as: "made", input: { ...who(), client_id: inp("client_id"), name: inp("name"), domain: inp("domain"), industry: inp("industry"), about: inp("about"), owner_id: inp("owner_id") } })],
  response: ref("made"), responseShape: {} as CompanyView,
});

export const getCompanyRoute = query({
  apiGroup: crmGroup, auth: user, name: "companies/{id}", verb: "GET",
  description: "A company, and everything around it that you can see.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: readCompany, as: "details", input: { ...who(), id: inp("id") } })],
  response: ref("details"), responseShape: {} as CompanyDetails,
});

export const companyPanelsRoute = query({
  apiGroup: crmGroup, auth: user, name: "companies/{id}/panels", verb: "GET",
  description: "What's linked to a company, up to a limit.",
  input: { id: id(), limit: input.int() },
  stack: [...caller(), s.function.run({ fn: companyPanels, as: "panels", input: { ...who(), id: inp("id"), limit: inp("limit") } })],
  response: ref("panels"), responseShape: {} as Panels,
});

export const updateCompanyRoute = query({
  apiGroup: crmGroup, auth: user, name: "companies/{id}", verb: "PATCH",
  description: "Change a company's details.",
  input: { id: id(), name: text(), domain: text(), industry: text(), about: text() },
  stack: [...caller(), s.function.run({ fn: updateCompany, as: "row", input: { ...who(), id: inp("id"), name: inp("name"), domain: inp("domain"), industry: inp("industry"), about: inp("about") } })],
  response: ref("row"), responseShape: {} as CompanyView,
});

export const assignCompanyRoute = query({
  apiGroup: crmGroup, auth: user, name: "companies/{id}/owner", verb: "POST",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Put a person or an agent in charge of a company, or nobody with 0.",
  input: { id: id(), owner_id: input.int() },
  stack: [...caller(), s.function.run({ fn: assignCompany, as: "row", input: { ...who(), id: inp("id"), owner_id: inp("owner_id") } })],
  response: ref("row"), responseShape: {} as CompanyView,
});

export const deleteCompanyRoute = query({
  apiGroup: crmGroup, auth: user, name: "companies/{id}", verb: "DELETE",
  description: "Put a company in the trash, with its contacts and deals.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: deleteCompany, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"), responseShape: {} as CompanyView,
});

export const restoreCompanyRoute = query({
  apiGroup: crmGroup, auth: user, name: "companies/{id}/restore", verb: "POST",
  description: "Bring a company back from the trash.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: restoreCompany, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"), responseShape: {} as CompanyView,
});

export const listContactsRoute = query({
  apiGroup: crmGroup, auth: user, name: "contacts", verb: "GET",
  description: "A page of contacts.",
  input: { q: text(), company_id: input.int(), page: input.int() },
  stack: [...caller(), s.function.run({ fn: listContacts, as: "page", input: { ...who(), q: inp("q"), company_id: inp("company_id"), page: inp("page") } })],
  response: ref("page"), responseShape: {} as ContactPage,
});

export const createContactRoute = query({
  apiGroup: crmGroup, auth: user, name: "contacts", verb: "POST",
  description: "Add a person to a company. Safe to retry with the same client_id.",
  input: { client_id: input.text({ required: true }), company_id: id(), name: text(), email: text(), phone: text(), job_title: text() },
  stack: [...caller(), s.function.run({ fn: createContact, as: "made", input: { ...who(), client_id: inp("client_id"), company_id: inp("company_id"), name: inp("name"), email: inp("email"), phone: inp("phone"), job_title: inp("job_title") } })],
  response: ref("made"), responseShape: {} as ContactView,
});

export const updateContactRoute = query({
  apiGroup: crmGroup, auth: user, name: "contacts/{id}", verb: "PATCH",
  description: "Change a contact's details.",
  input: { id: id(), name: text(), email: text(), phone: text(), job_title: text() },
  stack: [...caller(), s.function.run({ fn: updateContact, as: "row", input: { ...who(), id: inp("id"), name: inp("name"), email: inp("email"), phone: inp("phone"), job_title: inp("job_title") } })],
  response: ref("row"), responseShape: {} as ContactView,
});

export const deleteContactRoute = query({
  apiGroup: crmGroup, auth: user, name: "contacts/{id}", verb: "DELETE",
  description: "Put a contact in the trash.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: deleteContact, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"), responseShape: {} as ContactView,
});

export const restoreContactRoute = query({
  apiGroup: crmGroup, auth: user, name: "contacts/{id}/restore", verb: "POST",
  description: "Bring a contact back from the trash.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: restoreContact, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"), responseShape: {} as ContactView,
});

export const createDealRoute = query({
  apiGroup: crmGroup, auth: user, name: "deals", verb: "POST",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Add a deal to a company. Safe to retry with the same client_id.",
  input: { client_id: input.text({ required: true }), company_id: id(), stage_id: id(), title: text(), value: input.int(), close_on: input.text(), owner_id: input.int(), contact_id: input.int() },
  stack: [...caller(), s.function.run({ fn: createDeal, as: "made", input: {
    ...who(), client_id: inp("client_id"), company_id: inp("company_id"), stage_id: inp("stage_id"), title: inp("title"), value: inp("value"), close_on: inp("close_on"), owner_id: inp("owner_id"), contact_id: inp("contact_id"),
  } })],
  response: ref("made"), responseShape: {} as DealView,
});

export const getDealRoute = query({
  apiGroup: crmGroup, auth: user, name: "deals/{id}", verb: "GET",
  description: "A deal, and what you may do with it.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: readDeal, as: "details", input: { ...who(), id: inp("id") } })],
  response: ref("details"), responseShape: {} as DealDetails,
});

export const updateDealRoute = query({
  apiGroup: crmGroup, auth: user, name: "deals/{id}", verb: "PATCH",
  description: "Change a deal's title, value, close date and who it's with.",
  input: { id: id(), title: text(), value: input.int(), close_on: input.text(), contact_id: input.int() },
  stack: [...caller(), s.function.run({ fn: updateDeal, as: "row", input: { ...who(), id: inp("id"), title: inp("title"), value: inp("value"), close_on: inp("close_on"), contact_id: inp("contact_id") } })],
  response: ref("row"), responseShape: {} as DealView,
});

export const setDealStageRoute = query({
  apiGroup: crmGroup, auth: user, name: "deals/{id}/stage", verb: "POST",
  description: "Change a deal's stage.",
  input: { id: id(), stage_id: id() },
  stack: [...caller(), s.function.run({ fn: setDealStage, as: "row", input: { ...who(), id: inp("id"), stage_id: inp("stage_id") } })],
  response: ref("row"), responseShape: {} as DealView,
});

export const moveDealRoute = query({
  apiGroup: crmGroup, auth: user, name: "deals/{id}/move", verb: "POST",
  description: "Put a deal in a stage, above another deal or at the end.",
  input: { id: id(), stage_id: id(), before_id: input.int() },
  stack: [...caller(), s.function.run({ fn: moveDeal, as: "row", input: { ...who(), id: inp("id"), stage_id: inp("stage_id"), before_id: inp("before_id") } })],
  response: ref("row"), responseShape: {} as DealView,
});

export const assignDealRoute = query({
  apiGroup: crmGroup, auth: user, name: "deals/{id}/owner", verb: "POST",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Put a person or an agent on a deal, or nobody with 0.",
  input: { id: id(), owner_id: input.int() },
  stack: [...caller(), s.function.run({ fn: assignDeal, as: "row", input: { ...who(), id: inp("id"), owner_id: inp("owner_id") } })],
  response: ref("row"), responseShape: {} as DealView,
});

export const deleteDealRoute = query({
  apiGroup: crmGroup, auth: user, name: "deals/{id}", verb: "DELETE",
  description: "Put a deal in the trash.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: deleteDeal, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"), responseShape: {} as DealView,
});

export const restoreDealRoute = query({
  apiGroup: crmGroup, auth: user, name: "deals/{id}/restore", verb: "POST",
  description: "Bring a deal back from the trash.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: restoreDeal, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"), responseShape: {} as DealView,
});

export const addNoteRoute = query({
  apiGroup: crmGroup, auth: user, name: "crm-notes", verb: "POST",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Add a note to a company, a contact or a deal. Safe to retry with the same client_id.",
  input: { client_id: input.text({ required: true }), record_type: input.enum(NOTE_RECORDS, { required: true }), record_id: id(), body: text() },
  stack: [...caller(), s.function.run({ fn: addNote, as: "made", input: { ...who(), client_id: inp("client_id"), record_type: inp("record_type"), record_id: inp("record_id"), body: inp("body") } })],
  response: ref("made"), responseShape: {} as NoteView,
});

export const editNoteRoute = query({
  apiGroup: crmGroup, auth: user, name: "crm-notes/{id}", verb: "PATCH",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Change a note you wrote.",
  input: { id: id(), body: text() },
  stack: [...caller(), s.function.run({ fn: editNote, as: "row", input: { ...who(), id: inp("id"), body: inp("body") } })],
  response: ref("row"), responseShape: {} as NoteView,
});

export const deleteNoteRoute = query({
  apiGroup: crmGroup, auth: user, name: "crm-notes/{id}", verb: "DELETE",
  description: "Put a note in the trash.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: deleteNote, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"), responseShape: {} as NoteView,
});

export const restoreNoteRoute = query({
  apiGroup: crmGroup, auth: user, name: "crm-notes/{id}/restore", verb: "POST",
  description: "Bring a note back from the trash.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: restoreNote, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"), responseShape: {} as NoteView,
});

export const createStageRoute = query({
  apiGroup: crmGroup, auth: user, name: "stages", verb: "POST",
  description: "Add a stage to the pipeline.",
  input: { name: text() },
  stack: [...caller(), s.function.run({ fn: createStage, as: "made", input: { ...who(), name: inp("name") } })],
  response: ref("made"), responseShape: {} as Stage,
});

export const renameStageRoute = query({
  apiGroup: crmGroup, auth: user, name: "stages/{id}", verb: "PATCH",
  description: "Rename a stage.",
  input: { id: id(), name: text() },
  stack: [...caller(), s.function.run({ fn: renameStage, as: "row", input: { ...who(), id: inp("id"), name: inp("name") } })],
  response: ref("row"), responseShape: {} as Stage,
});

export const moveStageRoute = query({
  apiGroup: crmGroup, auth: user, name: "stages/{id}/move", verb: "POST",
  description: "Put a stage before another, or at the end.",
  input: { id: id(), before_id: input.int() },
  stack: [...caller(), s.function.run({ fn: moveStage, as: "row", input: { ...who(), id: inp("id"), before_id: inp("before_id") } })],
  response: ref("row"), responseShape: {} as Stage,
});

export const deleteStageRoute = query({
  apiGroup: crmGroup, auth: user, name: "stages/{id}", verb: "DELETE",
  description: "Delete an empty stage.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: deleteStage, as: "gone", input: { ...who(), id: inp("id") } })],
  response: ref("gone"), responseShape: {} as { removed: boolean },
});

export const crmQueries = [
  crmSetupRoute, pipelineRoute, crmSearchRoute, crmMentionCheck, crmReadRoute, listCompaniesRoute, createCompanyRoute, getCompanyRoute, companyPanelsRoute, updateCompanyRoute, assignCompanyRoute, deleteCompanyRoute, restoreCompanyRoute,
  listContactsRoute, createContactRoute, updateContactRoute, deleteContactRoute, restoreContactRoute, createDealRoute, getDealRoute, updateDealRoute, setDealStageRoute, moveDealRoute, assignDealRoute, deleteDealRoute, restoreDealRoute,
  addNoteRoute, editNoteRoute, deleteNoteRoute, restoreNoteRoute, createStageRoute, renameStageRoute, moveStageRoute, deleteStageRoute,
];

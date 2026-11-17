// The words and shapes of a CRM write. A refusal puts the screen back and names the record, so every label finishes "Couldn't …".
import type { EntityChange, EntityPatch } from "@/lib/data/entities";

export const dealPatch = (id: number, patch: EntityPatch): EntityChange => ({ entity: "deal", id, patch });
export const companyPatch = (id: number, patch: EntityPatch): EntityChange => ({ entity: "company", id, patch });
export const contactPatch = (id: number, patch: EntityPatch): EntityChange => ({ entity: "contact", id, patch });
export const insertDeal = (row: { id: number } & EntityPatch): EntityChange => ({ entity: "deal", id: row.id, patch: row, insert: true });
export const moveLabel = (title: string, stage: string) => `move ${title} to ${stage}`;

let stand = 0;
/** A stand-in id is negative, so it can't meet a real one. */
export const standIn = () => -(Date.now() * 1000 + (stand++ % 1000));

// The pipeline's stages. Everyone shares one pipeline, so changing it belongs to whoever holds crm.manage. Agents don't: the tool
// that saves records has no way here.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { deal } from "../../table/crm/deal.js";
import { pipeline_stage } from "../../table/crm/pipeline_stage.js";
import { NOT_FOUND } from "../access/reach.js";
import { notDeleted, requireCrm, requiredText, who } from "./shared.js";

const MOST_STAGES = 12;
const NOT_YOURS = "Only admins change the pipeline.";

/** Refuses anyone who can't change the pipeline, and an agent or a connection whatever its role says. */
const requireManager = statements(
  ...requireCrm(),
  guard.require(expr(inp("browser"), "=", c.bool(true)), { errorType: "accessdenied", message: NOT_YOURS }),
  s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "actor" }),
  guard.found("actor", { errorType: "accessdenied", message: NOT_YOURS }),
  rbac.allows(ref("actor.role"), "crm.manage", NOT_YOURS),
);
const nameRules = requiredText("name", 40, "Name the stage.", "the name");
const told = (id: Parameters<typeof changed>[0]["id"], op: "created" | "updated" | "deleted") => changed({ entity: "pipeline_stage", id, op, actor: inp("actor_id"), crm: true });
const ordered = (as: string) => s.db.query({ table: pipeline_stage, sort: [{ sortBy: "rank", dir: "asc" }, { sortBy: "id", dir: "asc" }], output: ["id", "kind"], as });

export const createStage = defineFunction({
  name: "crm/create_stage",
  description: "Add a stage, after the last open one.",
  input: { ...who, name: input.text() },
  stack: [
    ...requireManager,
    ...nameRules,
    ordered("stages"),
    guard.require(expr(withFilters(ref("stages"), fl.count()), "<", c.int(MOST_STAGES)), { errorType: "badrequest", message: `A pipeline holds ${MOST_STAGES} stages at most.` }),
    s.db.add({ table: pipeline_stage, as: "made", row: { name: inp("name"), kind: c.text("open"), rank: c.int(0), is_demo: c.bool(false) } }),
    // Numbered afresh, so a new stage sits before Won and Lost.
    s.set_var("next_rank", c.int(0)),
    s.foreach({ list: ref("stages"), as: "item", body: [
      s.conditional({ when: expr(ref("item.kind"), "=", c.text("open")), then: [
        s.update_var("next_rank", withFilters(ref("next_rank"), fl.add(c.int(1)))),
        s.db.patch({ table: pipeline_stage, fieldValue: ref("item.id"), data: obj({ rank: ref("next_rank") }) }),
      ] }),
    ] }),
    s.update_var("next_rank", withFilters(ref("next_rank"), fl.add(c.int(1)))),
    s.db.patch({ table: pipeline_stage, fieldValue: ref("made.id"), data: obj({ rank: ref("next_rank") }), as: "answer" }),
    s.foreach({ list: ref("stages"), as: "item", body: [
      s.conditional({ when: expr(ref("item.kind"), "!=", c.text("open")), then: [
        s.update_var("next_rank", withFilters(ref("next_rank"), fl.add(c.int(1)))),
        s.db.patch({ table: pipeline_stage, fieldValue: ref("item.id"), data: obj({ rank: ref("next_rank") }) }),
      ] }),
    ] }),
    told(ref("made.id"), "created"),
  ],
  response: ref("answer"),
});

export const renameStage = defineFunction({
  name: "crm/rename_stage",
  description: "Rename a stage.",
  input: { ...who, id: input.int({ required: true }), name: input.text() },
  stack: [
    ...requireManager,
    ...nameRules,
    s.db.get({ table: pipeline_stage, fieldValue: inp("id"), output: ["id"], as: "row" }),
    guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
    s.db.patch({ table: pipeline_stage, fieldValue: inp("id"), data: obj({ name: inp("name") }), as: "answer" }),
    told(inp("id"), "updated"),
    // A deal's card and its page show the stage's name.
    changed({ entity: "deal", id: c.int(0), actor: inp("actor_id"), crm: true }),
  ],
  response: ref("answer"),
});

export const moveStage = defineFunction({
  name: "crm/move_stage",
  description: "Put a stage just before another, or at the end with none.",
  input: { ...who, id: input.int({ required: true }), before_id: input.int() },
  stack: [
    ...requireManager,
    s.db.get({ table: pipeline_stage, fieldValue: inp("id"), output: ["id"], as: "row" }),
    guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
    ordered("stages"),
    s.set_var("next_rank", c.int(0)),
    s.foreach({ list: ref("stages"), as: "item", body: [
      s.conditional({ when: expr(ref("item.id"), "!=", inp("id")), then: [
        s.conditional({ when: expr(ref("item.id"), "=", inp("before_id")), then: [
          s.update_var("next_rank", withFilters(ref("next_rank"), fl.add(c.int(1)))),
          s.db.patch({ table: pipeline_stage, fieldValue: inp("id"), data: obj({ rank: ref("next_rank") }) }),
        ] }),
        s.update_var("next_rank", withFilters(ref("next_rank"), fl.add(c.int(1)))),
        s.db.patch({ table: pipeline_stage, fieldValue: ref("item.id"), data: obj({ rank: ref("next_rank") }) }),
      ] }),
    ] }),
    s.conditional({ when: expr(inp("before_id"), "=", c.int(0)), then: [
      s.update_var("next_rank", withFilters(ref("next_rank"), fl.add(c.int(1)))),
      s.db.patch({ table: pipeline_stage, fieldValue: inp("id"), data: obj({ rank: ref("next_rank") }) }),
    ] }),
    told(inp("id"), "updated"),
    s.db.get({ table: pipeline_stage, fieldValue: inp("id"), as: "answer" }),
  ],
  response: ref("answer"),
});

export const deleteStage = defineFunction({
  name: "crm/delete_stage",
  description: "Delete an empty open stage. A deal's history has nowhere to go, so its deals move first.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...requireManager,
    s.db.get({ table: pipeline_stage, fieldValue: inp("id"), output: ["kind"], as: "row" }),
    guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("row.kind"), "=", c.text("open")), { errorType: "badrequest", message: "The pipeline needs its Won and Lost stages." }),
    s.db.query({ table: deal, where: [cmp(col("stage_id"), "=", inp("id")), notDeleted()], returnType: "count", as: "held" }),
    guard.require(expr(ref("held"), "=", c.int(0)), { errorType: "badrequest", message: "Move this stage's deals first." }),
    s.db.query({ table: deal, where: cmp(col("stage_id"), "=", inp("id")), returnType: "count", as: "in_trash" }),
    guard.require(expr(ref("in_trash"), "=", c.int(0)), { errorType: "badrequest", message: "A deal in the trash still sits here. Try again once it's gone, or restore it and move it." }),
    s.db.del({ table: pipeline_stage, fieldValue: inp("id") }),
    told(inp("id"), "deleted"),
  ],
  response: { removed: c.bool(true) },
});

export const stageFunctions = [createStage, renameStage, moveStage, deleteStage];

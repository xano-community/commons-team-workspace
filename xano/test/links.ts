// Workflow tests for links, the batch resolver, the mention warning and the change path. Each makes its own rows: a test
// run starts with an empty database. Concurrent writers and live frames need real requests, so
// frontend/scripts/change-path-check.mjs proves those against a deployed backend.
import { c, fl, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { addLink, checkMention, dropLink, getLinks, resolveLinks } from "../query/links.js";
import { listChanges } from "../query/changes.js";
import { addSpaceMemberRoute, updateSpaceRoute } from "../query/spaces.js";
import { canReach } from "../function/access/reach.js";
import { forgetRecord, reconcileLinks } from "../function/links/links.js";
import { linkState } from "../function/links/records.js";
import { recordChange } from "../function/links/changes.js";
import { notification } from "../base/tables.js";
import { record_link } from "../table/links/record_link.js";
import { conversation } from "../table/messaging/conversation.js";
import { bearer, channel, dm, joined, makeSpace, missesText, no, notFound, person, personToken, seesText, settings } from "./access.js";

const ref2 = (type: string, id: Value) => obj({ type: c.text(type), id });
const channelRef = (key: string) => ref2("conversation", ref(`${key}.id`));
const resolve = (token: string, as: string, ...items: Value[]) => s.api.call({ api: resolveLinks, headers: bearer(token), input: { items: withFilters(c.array([]), ...items.map((i) => fl.array_push(i))) }, as });
const stateIs = (name: string, state: string) => s.expect.to_equal({ expr: ref(`${name}.0.state`), value: c.text(state) });
const link = (token: string, from: string, to: string, as: string) => s.api.call({ api: addLink, headers: bearer(token), as,
  input: { from_type: c.text("conversation"), from_id: ref(`${from}.id`), to_type: c.text("conversation"), to_id: ref(`${to}.id`) } });
const linksOf = (token: string, key: string, as: string) => s.api.call({ api: getLinks, headers: bearer(token), input: { type: c.text("conversation"), id: ref(`${key}.id`) }, as });
const count = (name: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(name), fl.count()), value: c.int(n) });

/** A team of two spaces: Ada in both, Ben in A, Cy in B, and a channel in each. */
const twoSpaces = [
  settings(), person("ada"), person("ben"), person("cy"),
  makeSpace("a"), makeSpace("b"), joined("a", "ada", "manager"), joined("b", "ada", "manager"), joined("a", "ben"), joined("b", "cy"),
  channel("in_a", "a"), channel("other_a", "a"), channel("in_b", "b"),
  personToken("ada", "ada_token"), personToken("ben", "ben_token"), personToken("cy", "cy_token"),
];

export const linkTests = [
  workflowTest({
    name: "links: a link needs reach on both ends, and otherwise answers not found",
    stack: [
      ...twoSpaces,
      link("ben_token", "in_a", "other_a", "made"),
      s.expect.to_equal({ expr: ref("made.from_id"), value: ref("in_a.id") }),
      link("ben_token", "in_a", "in_b", "to_unreached"), notFound("to_unreached"),
      link("ben_token", "in_b", "in_a", "from_unreached"), notFound("from_unreached"),
      s.api.call({ api: addLink, headers: bearer("ben_token"), as: "to_missing", input: { from_type: c.text("conversation"), from_id: ref("in_a.id"), to_type: c.text("conversation"), to_id: c.int(2147483647) } }), notFound("to_missing"),
      s.db.query({ table: record_link, returnType: "count", as: "rows" }),
      s.expect.to_equal({ expr: ref("rows"), value: c.int(1) }),
    ],
  }),
  workflowTest({
    name: "links: both sides show a link, one row a pair, and a link changes nobody's access",
    stack: [
      ...twoSpaces,
      link("ada_token", "in_a", "in_b", "made"),
      link("ada_token", "in_a", "in_b", "again"),
      s.expect.to_equal({ expr: ref("again.id"), value: ref("made.id") }),
      linksOf("ada_token", "in_a", "from_side"), count("from_side.forward", 1),
      s.expect.to_equal({ expr: ref("from_side.forward.0.title"), value: c.text("Channel in_b") }),
      linksOf("ada_token", "in_b", "to_side"), count("to_side.backlinks", 1),
      s.expect.to_equal({ expr: ref("to_side.backlinks.0.title"), value: c.text("Channel in_a") }),
      s.function.call({ fn: canReach, as: "ben_reaches", input: { actor_id: ref("ben.id"), browser: c.bool(true), type: c.text("conversation"), id: ref("in_b.id") } }), no("ben_reaches"),
    ],
  }),
  workflowTest({
    name: "links: a viewer who reaches one side gets a locked chip with no title, and no backlink, in the API itself",
    stack: [
      ...twoSpaces,
      link("ada_token", "in_a", "in_b", "made"),
      resolve("ben_token", "ben_view", channelRef("in_b")), stateIs("ben_view", "locked"), missesText("ben_view", "Channel in_b"),
      s.expect.to_equal({ expr: ref("ben_view.0.href"), value: c.text("") }),
      linksOf("ben_token", "in_a", "ben_links"), count("ben_links.forward", 1), stateIs("ben_links.forward", "locked"), missesText("ben_links", "Channel in_b"),
      linksOf("ben_token", "in_b", "ben_target"), notFound("ben_target"),
      linksOf("cy_token", "in_b", "cy_links"), count("cy_links.backlinks", 0),
      s.expect.to_equal({ expr: ref("cy_links.backlinks_total"), value: c.int(0) }),
      missesText("cy_links", "Channel in_a"),
      linksOf("ada_token", "in_b", "ada_links"),
      s.expect.to_equal({ expr: ref("ada_links.backlinks_total"), value: c.int(1) }),
    ],
  }),
  workflowTest({
    name: "links: a rename shows everywhere at once, because nothing stored the name",
    stack: [
      ...twoSpaces,
      link("ada_token", "in_a", "other_a", "made"),
      s.db.patch({ table: conversation, fieldValue: ref("other_a.id"), data: obj({ name: c.text("Renamed") }) }),
      linksOf("ben_token", "in_a", "after"),
      s.expect.to_equal({ expr: ref("after.forward.0.title"), value: c.text("Renamed") }),
      s.db.get({ table: record_link, fieldValue: ref("made.id"), as: "row" }),
      missesText("row", "Channel other_a"),
    ],
  }),
  workflowTest({
    name: "links: a target in trash reads Deleted, offers Restore if allowed, and a restore brings it back",
    description: "No record type has a trash yet, so this asks the state rule directly. Each tool adds its type to links/locate.",
    stack: [
      s.function.call({ fn: linkState, as: "trashed", input: { found: c.bool(true), reachable: c.bool(true), archived: c.bool(false), trashed: c.bool(true), tombstone: c.bool(false) } }),
      s.expect.to_equal({ expr: ref("trashed"), value: c.text("deleted") }),
      s.function.call({ fn: linkState, as: "trashed_unreached", input: { found: c.bool(true), reachable: c.bool(false), archived: c.bool(false), trashed: c.bool(true), tombstone: c.bool(false) } }),
      s.expect.to_equal({ expr: ref("trashed_unreached"), value: c.text("locked") }),
      s.function.call({ fn: linkState, as: "restored", input: { found: c.bool(true), reachable: c.bool(true), archived: c.bool(false), trashed: c.bool(false), tombstone: c.bool(false) } }),
      s.expect.to_equal({ expr: ref("restored"), value: c.text("live") }),
      s.function.call({ fn: linkState, as: "message_deleted", input: { found: c.bool(true), reachable: c.bool(true), archived: c.bool(false), trashed: c.bool(false), tombstone: c.bool(true) } }),
      s.expect.to_equal({ expr: ref("message_deleted"), value: c.text("tombstone") }),
    ],
  }),
  workflowTest({
    name: "links: a target in an archived space reads Archived to people who reach it, and stays locked for the rest",
    stack: [
      ...twoSpaces,
      link("ada_token", "in_a", "in_b", "made"),
      s.api.call({ api: updateSpaceRoute, headers: bearer("ada_token"), as: "archived", input: { id: ref("b.id"), name: c.text("Space b"), visibility: c.text("private"), archived: c.bool(true) } }),
      resolve("ada_token", "ada_view", channelRef("in_b")), stateIs("ada_view", "archived"),
      s.expect.to_equal({ expr: ref("ada_view.0.title"), value: c.text("Channel in_b") }),
      resolve("ben_token", "ben_view", channelRef("in_b")), stateIs("ben_view", "locked"), missesText("ben_view", "Channel in_b"),
      link("ada_token", "in_b", "in_a", "from_archived"),
      s.expect.to_equal({ expr: ref("from_archived.message"), value: c.text("This space is archived.") }),
    ],
  }),
  workflowTest({
    name: "links: a purged target reads Deleted to everyone, and its link rows are gone",
    stack: [
      ...twoSpaces,
      link("ada_token", "in_a", "in_b", "out"),
      link("ada_token", "other_a", "in_a", "back"),
      s.db.del({ table: conversation, fieldValue: ref("in_b.id") }),
      s.function.call({ fn: forgetRecord, as: "gone", input: { type: c.text("conversation"), id: ref("in_b.id") } }),
      resolve("ada_token", "ada_view", channelRef("in_b")), stateIs("ada_view", "deleted"),
      resolve("ben_token", "ben_view", channelRef("in_b")), stateIs("ben_view", "deleted"),
      s.db.query({ table: record_link, returnType: "count", as: "left" }),
      s.expect.to_equal({ expr: ref("left"), value: c.int(1) }),
    ],
  }),
  workflowTest({
    name: "links: saving a body reconciles only its own links, keeps what the saver can't see, and tells nobody",
    stack: [
      ...twoSpaces,
      s.function.call({ fn: reconcileLinks, as: "first", input: { actor_id: ref("ada.id"), browser: c.bool(true), from_type: c.text("conversation"), from_id: ref("in_a.id"), targets: withFilters(c.array([]), fl.array_push(channelRef("other_a")), fl.array_push(channelRef("in_b"))) } }),
      s.expect.to_equal({ expr: ref("first.added"), value: c.int(2) }),
      s.api.call({ api: addLink, headers: bearer("ben_token"), as: "by_hand", input: { from_type: c.text("conversation"), from_id: ref("in_a.id"), to_type: c.text("space"), to_id: ref("a.id") } }),
      // Ben re-saves with the channel he can see. The one he can't is still in the body, under a locked chip.
      s.function.call({ fn: reconcileLinks, as: "second", input: { actor_id: ref("ben.id"), browser: c.bool(true), from_type: c.text("conversation"), from_id: ref("in_a.id"), targets: withFilters(c.array([]), fl.array_push(channelRef("in_b"))) } }),
      s.expect.to_equal({ expr: ref("second.removed"), value: c.int(1) }),
      s.db.query({ table: record_link, sort: [{ sortBy: "id", dir: "asc" }], as: "rows" }),
      count("rows", 2),
      seesText("rows", "manual"),
      // A body can't create a link its author doesn't reach: it's skipped, and says nothing about why.
      s.function.call({ fn: reconcileLinks, as: "third", input: { actor_id: ref("cy.id"), browser: c.bool(true), from_type: c.text("conversation"), from_id: ref("in_b.id"), targets: withFilters(c.array([]), fl.array_push(channelRef("in_a"))) } }),
      s.expect.to_equal({ expr: ref("third.added"), value: c.int(0) }),
      s.db.query({ table: notification, returnType: "count", as: "told" }),
      s.expect.to_equal({ expr: ref("told"), value: c.int(0) }),
    ],
  }),
  workflowTest({
    name: "links: removing a link needs both ends, and leaves a body's other links",
    stack: [
      ...twoSpaces,
      link("ada_token", "in_a", "in_b", "hidden"),
      s.api.call({ api: dropLink, headers: bearer("ben_token"), input: { id: ref("hidden.id") }, as: "refused" }), notFound("refused"),
      s.api.call({ api: dropLink, headers: bearer("ada_token"), input: { id: ref("hidden.id") }, as: "removed" }),
      s.expect.to_be_true({ expr: ref("removed.removed") }),
    ],
  }),
  workflowTest({
    name: "mention warning: a manager is told who can't reach the record, and can add them",
    stack: [
      settings(), person("sam"), person("mia"), person("non1"), person("non2"), person("boss", "admin"),
      makeSpace("vault"), makeSpace("team"), joined("vault", "sam", "manager"), joined("vault", "mia"),
      joined("team", "sam"), joined("team", "mia"), joined("team", "non1"), joined("team", "non2"), joined("team", "boss"),
      channel("plans", "vault"), channel("general", "team"),
      personToken("sam", "sam_token"), personToken("mia", "mia_token"), personToken("non1", "non_token"),
      s.api.call({ api: checkMention, headers: bearer("sam_token"), as: "check", input: { audience_type: c.text("conversation"), audience_id: ref("general.id"), records: withFilters(c.array([]), fl.array_push(channelRef("plans"))) } }),
      s.expect.to_be_true({ expr: ref("check.warn") }),
      count("check.missing", 2),
      seesText("check", "Test non1"), seesText("check", "Test non2"),
      // An admin outside the space already reaches it, so the warning doesn't name them.
      missesText("check", "Test boss"), missesText("check", "Test mia"),
      s.expect.to_equal({ expr: ref("check.add.0.space_id"), value: ref("vault.id") }),
      count("check.add.0.user_ids", 2),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("sam_token"), as: "added", input: { id: ref("vault.id"), user_id: ref("non1.id") } }),
      s.api.call({ api: checkMention, headers: bearer("sam_token"), as: "after", input: { audience_type: c.text("conversation"), audience_id: ref("general.id"), records: withFilters(c.array([]), fl.array_push(channelRef("plans"))) } }),
      count("after.missing", 1),
    ],
  }),
  workflowTest({
    name: "mention warning: a member who can't manage the space gets no add, and non-members still see a locked chip",
    stack: [
      settings(), person("sam"), person("mia"), person("non1"),
      makeSpace("vault"), makeSpace("team"), joined("vault", "sam", "manager"), joined("vault", "mia"),
      joined("team", "mia"), joined("team", "non1"),
      channel("plans", "vault"), channel("general", "team"),
      personToken("mia", "mia_token"), personToken("non1", "non_token"),
      s.api.call({ api: checkMention, headers: bearer("mia_token"), as: "check", input: { audience_type: c.text("conversation"), audience_id: ref("general.id"), records: withFilters(c.array([]), fl.array_push(channelRef("plans"))) } }),
      s.expect.to_be_true({ expr: ref("check.warn") }),
      count("check.missing", 1),
      s.expect.to_be_empty({ expr: ref("check.add") }),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("mia_token"), as: "add_refused", input: { id: ref("vault.id"), user_id: ref("non1.id") } }),
      s.expect.to_equal({ expr: ref("add_refused.message"), value: c.text("Only this space's managers can do that.") }),
      resolve("non_token", "chip", channelRef("plans")), stateIs("chip", "locked"), missesText("chip", "Channel plans"),
      s.function.call({ fn: canReach, as: "still_out", input: { actor_id: ref("non1.id"), browser: c.bool(true), type: c.text("conversation"), id: ref("plans.id") } }), no("still_out"),
    ],
  }),
  workflowTest({
    name: "mention warning: nothing to say when everyone reaches it, and a sender can't probe a record or audience they don't reach",
    stack: [
      ...twoSpaces,
      s.api.call({ api: checkMention, headers: bearer("ben_token"), as: "quiet", input: { audience_type: c.text("conversation"), audience_id: ref("in_a.id"), records: withFilters(c.array([]), fl.array_push(channelRef("other_a"))) } }),
      s.expect.to_be_false({ expr: ref("quiet.warn") }),
      s.api.call({ api: checkMention, headers: bearer("ben_token"), as: "not_audience", input: { audience_type: c.text("conversation"), audience_id: ref("in_b.id"), records: withFilters(c.array([]), fl.array_push(channelRef("in_a"))) } }), notFound("not_audience"),
      s.api.call({ api: checkMention, headers: bearer("ben_token"), as: "not_record", input: { audience_type: c.text("conversation"), audience_id: ref("in_a.id"), records: withFilters(c.array([]), fl.array_push(channelRef("in_b"))) } }),
      s.expect.to_be_false({ expr: ref("not_record.warn") }),
      s.expect.to_be_empty({ expr: ref("not_record.missing") }),
    ],
  }),
  workflowTest({
    name: "changes: each channel counts in order, and `after` returns only what's newer, ids and no text",
    stack: [
      ...twoSpaces,
      s.function.call({ fn: recordChange, as: "one", input: { channel: c.text("crm"), entity: c.text("deal"), id: c.int(7), op: c.text("updated"), actor_id: ref("ada.id") } }),
      s.function.call({ fn: recordChange, as: "two", input: { channel: c.text("crm"), entity: c.text("company"), id: c.int(8), op: c.text("updated"), actor_id: ref("ada.id") } }),
      s.expect.to_equal({ expr: ref("two"), value: withFilters(ref("one"), fl.add(c.int(1))) }),
      s.set_var("a_channel", withFilters(c.text("spaces/"), fl.concat(ref("a.id")))),
      s.function.call({ fn: recordChange, as: "first_task", input: { channel: ref("a_channel"), entity: c.text("task"), id: c.int(1), op: c.text("created"), actor_id: ref("ada.id") } }),
      s.expect.to_equal({ expr: ref("first_task"), value: c.int(1) }),
      s.api.call({ api: listChanges, headers: bearer("ada_token"), input: { channel: c.text("crm"), after: ref("one") }, as: "newer" }),
      count("newer.items", 1),
      s.expect.to_equal({ expr: ref("newer.items.0.entity"), value: c.text("company") }),
      s.expect.to_equal({ expr: ref("newer.seq"), value: ref("two") }),
      s.api.call({ api: listChanges, headers: bearer("ada_token"), input: { channel: c.text("crm"), after: c.int(-1) }, as: "head" }),
      s.expect.to_be_empty({ expr: ref("head.items") }),
      s.expect.to_equal({ expr: ref("head.seq"), value: ref("two") }),
      // A link write lands on its source's channel, and reaches the log through app/changed.
      link("ada_token", "in_a", "other_a", "made"),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: ref("a_channel"), after: ref("first_task") }, as: "linked" }),
      s.expect.to_equal({ expr: ref("linked.items.0.entity"), value: c.text("record_link") }),
      missesText("linked", "Channel"),
    ],
  }),
  workflowTest({
    name: "changes: only people who may join a channel read its log",
    stack: [
      ...twoSpaces, person("gus", "guest"), joined("a", "gus"), personToken("gus", "gus_token"),
      s.set_var("b_channel", withFilters(c.text("spaces/"), fl.concat(ref("b.id")))),
      s.set_var("ada_channel", withFilters(c.text("users/"), fl.concat(ref("ada.id")))),
      s.set_var("ben_channel", withFilters(c.text("users/"), fl.concat(ref("ben.id")))),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: ref("b_channel") }, as: "other_space" }), notFound("other_space"),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: ref("ada_channel") }, as: "other_person" }), notFound("other_person"),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: ref("ben_channel") }, as: "own" }),
      s.expect.to_equal({ expr: ref("own.channel"), value: ref("ben_channel") }),
      s.api.call({ api: listChanges, headers: bearer("gus_token"), input: { channel: c.text("crm") }, as: "guest_crm" }), notFound("guest_crm"),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: c.text("crm") }, as: "member_crm" }),
      s.expect.to_equal({ expr: ref("member_crm.channel"), value: c.text("crm") }),
      s.expect.to_equal({ expr: withFilters(ref("member_crm.seq"), fl.is_int()), value: c.bool(true) }),
      s.expect.to_equal({ expr: ref("member_crm.seq"), value: c.int(0) }),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: c.text("spaces/1x") }, as: "bad_name" }), notFound("bad_name"),
    ],
  }),
  workflowTest({
    name: "resolver: a DM reads only to its members, admins included",
    stack: [
      settings(), person("ada"), person("ben"), person("boss", "admin"),
      ...dm("private_chat", "ada", "ben"),
      personToken("ada", "ada_token"), personToken("boss", "boss_token"),
      resolve("ada_token", "ada_view", channelRef("private_chat")), stateIs("ada_view", "live"),
      resolve("boss_token", "boss_view", channelRef("private_chat")), stateIs("boss_view", "locked"), missesText("boss_view", "DM private_chat"),
    ],
  }),
];

import { describe, expect, it } from "vitest";
import { activeTrigger, applyPick, decodeBody, encodeBody, parseBody, peopleIn, recordsIn, stripRecords } from "./tokens";

describe("reading a body", () => {
  it("splits text, people, records and links, and leaves anything else as text", () => {
    expect(parseBody("hi <@5>, see <#doc:12> at https://x.io/a. <b>")).toEqual([
      { t: "text", v: "hi " }, { t: "person", id: 5 }, { t: "text", v: ", see " }, { t: "record", type: "doc", id: 12 }, { t: "text", v: " at " },
      { t: "link", url: "https://x.io/a" }, { t: "text", v: ". <b>" },
    ]);
  });

  it("never treats a script address as a link", () => {
    expect(parseBody("javascript:void(0)")).toEqual([{ t: "text", v: "javascript:void(0)" }]);
  });

  it("finds who and what it names", () => {
    expect(peopleIn("<@1> <@2> <@1>")).toEqual([1, 2]);
    expect(recordsIn("<#doc:1> <#task:2> <#doc:1>")).toEqual([{ type: "doc", id: 1 }, { type: "task", id: 2 }]);
  });
});

describe("the composer's text", () => {
  const picks = [{ display: "@Morgan Reyes", token: "<@2>" }, { display: "@Morgan", token: "<@3>" }, { display: "#general", token: "<#conversation:7>" }];

  it("sends tokens for what was picked, longest name first", () => {
    expect(encodeBody("@Morgan Reyes and @Morgan in #general", picks)).toBe("<@2> and <@3> in <#conversation:7>");
  });

  it("sends plain text when a picked name was typed over", () => {
    expect(encodeBody("@Morga hello", picks)).toBe("@Morga hello");
  });

  it("turns a body back into what the person wrote, keeping what it can't name", () => {
    const { text, picks: back } = decodeBody("<@2> in <#conversation:7> and <#doc:9>", { person: (id) => (id === 2 ? "Morgan Reyes" : null), record: (_t, id) => (id === 7 ? "general" : null) });
    expect(text).toBe("@Morgan Reyes in #general and <#doc:9>");
    expect(encodeBody(text, back)).toBe("<@2> in <#conversation:7> and <#doc:9>");
  });

  it("takes a record's mention out, tidily", () => {
    expect(stripRecords("see <#doc:1> now")).toBe("see now");
  });
});

describe("the @ and # menus", () => {
  it("opens on a word starting with the trigger at the caret, and not inside an address", () => {
    expect(activeTrigger("hi @mo", 6)).toEqual({ char: "@", query: "mo", start: 3 });
    expect(activeTrigger("#", 1)).toEqual({ char: "#", query: "", start: 0 });
    expect(activeTrigger("me@work.com", 11)).toBeNull();
    expect(activeTrigger("hi @mo there", 12)).toBeNull();
  });

  it("puts the pick in, with a space, and says where the caret goes", () => {
    expect(applyPick("hi @mo!", { char: "@", query: "mo", start: 3 }, 6, "@Morgan")).toEqual({ text: "hi @Morgan !", caret: 11 });
  });
});

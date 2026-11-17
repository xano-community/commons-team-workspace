import { describe, expect, it } from "vitest";
import { MOST_TOOLS, withinToolLimit } from "./tool-limit";

const tools = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `tool_${i}` }));

describe("the tool limit", () => {
  it("lets 11 and 12 through", () => {
    expect(withinToolLimit(tools(11))).toHaveLength(11);
    expect(withinToolLimit(tools(MOST_TOOLS))).toHaveLength(MOST_TOOLS);
  });
  it("stops the build at 13, and names them", () => {
    expect(() => withinToolLimit(tools(13))).toThrow(/13 tools, and the limit is 12: tool_0/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DURATION, EASE_CSS } from "./index";

const css = readFileSync("frontend/src/components/kit/kit.css", "utf8");
const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

describe("motion tokens", () => {
  it("are the same in CSS and in code", () => {
    expect(css).toContain(`--ease-out: ${EASE_CSS};`);
    for (const [name, ms] of Object.entries(DURATION)) expect(css).toContain(`--duration-${name}: ${ms}ms;`);
  });

  it("are the four steps on the one curve", () => {
    expect(Object.values(DURATION)).toEqual([100, 150, 200, 250]);
    expect(EASE_CSS).toBe("cubic-bezier(0.23, 1, 0.32, 1)");
  });
});

describe("reduced motion", () => {
  it("removes every transform an enter or exit uses", () => {
    for (const v of ["enter-translate-x", "enter-translate-y", "exit-translate-x", "exit-translate-y"]) expect(reduced).toContain(`--tw-${v}: 0 !important`);
    expect(reduced).toContain("--tw-enter-scale: 1 !important");
    expect(reduced).toContain("--tw-exit-scale: 1 !important");
  });

  it("keeps fades, and transitions nothing that moves", () => {
    const property = reduced.match(/transition-property: ([^;]+);/)![1];
    expect(property).toContain("opacity");
    expect(property).not.toMatch(/transform|translate|scale|width|height|left|top/);
    expect(reduced).not.toMatch(/animation-duration|transition-duration/);
  });
});

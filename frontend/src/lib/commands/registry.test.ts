import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogCommands } from "./catalog";
import { NAV_KEYS } from "./shell-catalog";
import { findClashes, matchesStep, normalizeShortcut, shortcutKeys, type Command } from "./registry";
import { listenForCommands, registerCommands } from "./store";

const cmd = (id: string, shortcut: string, scope: Command["scope"] = "global"): Command => ({ id, label: id, shortcut, scope, run: () => {} });

describe("shortcut clashes", () => {
  it("none in the app's own table", () => {
    expect(findClashes(catalogCommands())).toEqual([]);
  });

  it("finds the same key twice in a scope, however it's spelled", () => {
    expect(findClashes([cmd("a", "Shift+Mod+K"), cmd("b", "mod+shift+k")])).toMatchObject([{ shortcut: "mod+shift+k", ids: ["a", "b"] }]);
  });

  it("finds the same key on two screens, so a key keeps its meaning from screen to screen", () => {
    expect(findClashes([cmd("tasks.new", "n", "screen"), cmd("docs.new", "n", "screen")])).toHaveLength(1);
  });

  it("finds a screen key hiding a global one, and lets a modal or an editor do it", () => {
    expect(findClashes([cmd("a", "?"), cmd("b", "?", "screen")])).toHaveLength(1);
    expect(findClashes([cmd("a", "mod+k"), cmd("b", "mod+k", "modal")])).toEqual([]);
    expect(findClashes([cmd("a", "mod+k"), cmd("b", "mod+k", "editor")])).toEqual([]);
  });

  it("finds a single key that swallows a chord", () => {
    expect(findClashes([cmd("a", "g o"), cmd("b", "g", "screen")])[0]).toMatchObject({ shortcut: "g", why: "it swallows the chord g o" });
  });

  it("finds a key the browser keeps", () => {
    expect(findClashes([cmd("a", "mod+w")])).toMatchObject([{ why: "the browser keeps this key" }]);
  });

  it("a shortcut clash is refused when it's registered", () => {
    const off = registerCommands([cmd("a", "n", "screen")]);
    expect(() => registerCommands([cmd("b", "n", "screen")])).toThrow(/clash on n/);
    off();
  });
});

describe("nav keys", () => {
  it("are pinned: every letter once, none taken by a single-key command", () => {
    const letters = Object.values(NAV_KEYS);
    expect(new Set(letters).size).toBe(letters.length);
  });
});

describe("matching a key press", () => {
  const press = (key: string, mods: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, ...mods });
  it("reads mod as ⌘ or Ctrl, and tells a plain key from a modified one", () => {
    expect(matchesStep(press("k", { metaKey: true }), "mod+k")).toBe(true);
    expect(matchesStep(press("k", { ctrlKey: true }), "mod+k")).toBe(true);
    expect(matchesStep(press("k"), "mod+k")).toBe(false);
    expect(matchesStep(press("k", { metaKey: true }), "k")).toBe(false);
    expect(matchesStep(press("K", { shiftKey: true }), "k")).toBe(false);
  });
  it("takes a symbol as typed, whatever shift produced it", () => {
    expect(matchesStep(press("?", { shiftKey: true }), "?")).toBe(true);
  });
  it("normalizes and shows a chord", () => {
    expect(normalizeShortcut("G  O")).toBe("g o");
    expect(shortcutKeys("g o")).toEqual(["G", "O"]);
  });
});

describe("the key handler", () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; document.body.innerHTML = ""; });
  const mount = (...list: Command[]) => { cleanup.push(registerCommands(list), listenForCommands()); };
  const press = (key: string, target: EventTarget = window, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

  it("runs a chord, and lets it lapse", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    mount({ ...cmd("go", "g o"), run });
    press("g"); press("o");
    expect(run).toHaveBeenCalledTimes(1);
    press("g"); vi.advanceTimersByTime(1300); press("o");
    expect(run).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("ignores single keys while someone types, and still honours mod keys", () => {
    const single = vi.fn(), mod = vi.fn();
    mount({ ...cmd("s", "?"), run: single }, { ...cmd("m", "mod+k"), run: mod });
    const input = document.body.appendChild(document.createElement("input"));
    press("?", input);
    press("k", input, { metaKey: true });
    expect(single).not.toHaveBeenCalled();
    expect(mod).toHaveBeenCalledTimes(1);
  });

  it("does no work for a plain key typed in a field, and a chord typed there still lapses", () => {
    const when = vi.fn(() => true), go = vi.fn();
    mount({ ...cmd("m", "mod+k"), when }, { ...cmd("go", "g o"), run: go });
    const area = document.body.appendChild(document.createElement("textarea"));
    press("a", area); press("b", area, { shiftKey: true });
    expect(when).not.toHaveBeenCalled();
    press("g"); press("x", area); press("o");
    expect(go).not.toHaveBeenCalled();
    when.mockClear();
    press("k", area, { ctrlKey: true });
    expect(when).toHaveBeenCalledTimes(1);
  });

  it("runs only modal commands while a modal is open", () => {
    const global = vi.fn(), modal = vi.fn();
    mount({ ...cmd("g", "mod+k"), run: global }, { ...cmd("m", "mod+k", "modal"), run: modal });
    document.body.innerHTML = "<dialog open></dialog>";
    press("k", window, { metaKey: true });
    expect(modal).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });

  it("skips a command whose when() says no", () => {
    const run = vi.fn();
    mount({ ...cmd("w", "n", "screen"), when: () => false, run });
    press("n");
    expect(run).not.toHaveBeenCalled();
  });
});

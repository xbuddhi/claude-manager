import { describe, expect, it, vi } from "vitest";
import { Strip, type StripHandlers } from "./tabs";

function setup() {
  const slot = document.createElement("div");
  document.body.append(slot);
  const h: StripHandlers = {
    select: vi.fn(),
    close: vi.fn(),
    moveOut: vi.fn(),
    reorder: vi.fn(),
    tearOff: vi.fn(),
    dragOver: vi.fn(async () => null),
    menu: vi.fn(),
  };
  return { slot, h, strip: new Strip(slot, h) };
}

const tabs = [
  { id: 1, title: "New session", sub: "app  ·  work", exited: false, dir: "/c/app", group: "/c/app" },
  { id: 2, title: "Fix tests", sub: "web  ·  default", exited: false, dir: "/c/web", group: "/c/web" },
  { id: 3, title: "Old chat", sub: "api  ·  work", exited: true, dir: "/c/api", group: "/c/api" },
];

describe("tab strip", () => {
  it("is hidden without terminals", () => {
    const { slot, strip } = setup();
    strip.render([], null);
    expect(slot.hidden).toBe(true);
    strip.render(tabs, null);
    expect(slot.hidden).toBe(false);
  });

  it("always shows the active tab and lists the rest under 'more'", () => {
    const { slot, strip } = setup();
    // the test DOM has no width: one tab fits
    strip.render(tabs, 3);
    const shown = [...slot.querySelectorAll<HTMLElement>(".term-tab")].map((t) => t.dataset.key);
    expect(shown).toEqual(["0", "3"]);
    expect(slot.querySelector(".term-more")?.textContent).toContain("2");
    expect(slot.querySelector('.term-tab[data-key="3"]')?.getAttribute("aria-selected")).toBe("true");
    // every clickable thing is a button or a tab (the strip is a window drag region)
    for (const el of slot.querySelectorAll("[data-act]")) expect(el.tagName).toBe("BUTTON");
  });

  it("routes clicks, middle-clicks and right-clicks", () => {
    const { slot, h, strip } = setup();
    strip.render(tabs, 1);
    const tab = slot.querySelector<HTMLElement>('.term-tab[data-key="1"]') as HTMLElement;
    tab.querySelector<HTMLElement>('[data-act="close"]')?.click();
    expect(h.close).toHaveBeenCalledWith(1);
    tab.querySelector<HTMLElement>('[data-act="pop"]')?.click();
    expect(h.moveOut).toHaveBeenCalledWith(1);
    slot.querySelector<HTMLElement>(".term-home")?.click();
    expect(h.select).toHaveBeenCalledWith(null);
    tab.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    expect(h.close).toHaveBeenCalledTimes(2);
    tab.dispatchEvent(new MouseEvent("contextmenu", { clientX: 5, clientY: 6, bubbles: true }));
    expect(h.menu).toHaveBeenCalledWith(1, { x: 5, y: 6 });
  });

  it("moves a tab dragged off the strip to another window", () => {
    const { slot, h, strip } = setup();
    strip.render(tabs, 1);
    const tab = slot.querySelector<HTMLElement>('.term-tab[data-key="1"]') as HTMLElement;
    const at = (type: string, x: number, y: number) =>
      tab.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true }));
    at("pointerdown", 10, 10);
    at("pointermove", 14, 300);
    expect(tab.classList.contains("torn")).toBe(true);
    at("pointerup", 14, 300);
    expect(h.tearOff).toHaveBeenCalledTimes(1);
    expect(h.tearOff).toHaveBeenCalledWith(1, expect.anything());
    expect(h.reorder).not.toHaveBeenCalled();
    // the click that ends the drag does not select
    tab.click();
    expect(h.select).not.toHaveBeenCalled();
  });

  it("moves the active marks without drawing the tabs again when only the active tab changes", () => {
    const { slot, strip } = setup();
    const one = [{ ...tabs[0], title: "Only" } as (typeof tabs)[number]];
    strip.render(one, null);
    const home = slot.querySelector<HTMLElement>(".term-home");
    const node = slot.querySelector<HTMLElement>('.term-tab[data-key="1"]');
    strip.render(one, 1);
    expect(slot.querySelector('.term-tab[data-key="1"]')).toBe(node);
    expect(node?.getAttribute("aria-selected")).toBe("true");
    expect(node?.classList.contains("active")).toBe(true);
    expect(node?.tabIndex).toBe(0);
    expect(home?.getAttribute("aria-selected")).toBe("false");
    expect(home?.tabIndex).toBe(-1);
    // a changed tab draws the strip again
    strip.render([{ ...one[0], exited: true } as (typeof tabs)[number]], 1);
    expect(slot.querySelector('.term-tab[data-key="1"]')).not.toBe(node);
    expect(slot.querySelector('.term-tab[data-key="1"]')?.classList.contains("exited")).toBe(true);
  });

  it("renames a tab in place", () => {
    const { slot, strip } = setup();
    strip.render(tabs, 1);
    const node = slot.querySelector('.term-tab[data-key="1"]');
    strip.setTitle(1, "Refactor the parser");
    expect(slot.querySelector('.term-tab[data-key="1"]')).toBe(node);
    expect(node?.querySelector(".term-title")?.textContent).toBe("Refactor the parser");
  });
});

describe("folder groups", () => {
  /** A strip wide enough for every tab (the test DOM has no layout). */
  function wide() {
    const s = setup();
    Object.defineProperty(s.slot.querySelector(".term-tabs"), "clientWidth", { value: 1600 });
    return s;
  }
  const two = [
    { id: 1, title: "One", sub: "", exited: false, dir: "/c/app", group: "/c/app" },
    { id: 2, title: "Two", sub: "", exited: false, dir: "/c/app", group: "/c/app" },
    { id: 3, title: "Three", sub: "", exited: false, dir: "/c/web", group: "/c/web" },
  ];

  it("puts a chip before a folder with two or more tabs", () => {
    const { slot, strip } = wide();
    strip.render(two, 3);
    const chips = [...slot.querySelectorAll<HTMLElement>(".term-group")];
    expect(chips.map((c) => c.textContent)).toEqual(["app"]);
    expect(chips[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(slot.querySelectorAll(".term-tab.grouped")).toHaveLength(2);
  });

  it("folds a folder's tabs behind its chip, and the tab in front moves out of it", () => {
    const { slot, strip, h } = wide();
    strip.render(two, 3);
    slot.querySelector<HTMLElement>(".term-group")?.click();
    expect(slot.querySelector('.term-tab[data-key="1"]')).toBeNull();
    expect(slot.querySelector(".term-group")?.getAttribute("aria-expanded")).toBe("false");
    expect(slot.querySelector(".term-group-count")?.textContent).toBe("2");

    strip.render(two, 1);
    // the folder's tab came to the front: the folder unfolds
    expect(slot.querySelector('.term-tab[data-key="2"]')).not.toBeNull();
    slot.querySelector<HTMLElement>(".term-group")?.click();
    expect(h.select).toHaveBeenCalledWith(3);
  });
});

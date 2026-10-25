import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMenus, firstIndex, lastIndex, type MenuItem, nextIndex, showMenu } from "./menu";

const items: MenuItem[] = [
  { kind: "section", label: "Open in" },
  { label: "VS Code" },
  { label: "Disabled", disabled: true },
  { kind: "separator" },
  { label: "Copy path" },
  { label: "Close", danger: true },
];

describe("menu navigation indexes", () => {
  it("skips sections, separators and disabled items, wrapping around", () => {
    expect(firstIndex(items)).toBe(1);
    expect(lastIndex(items)).toBe(5);
    expect(nextIndex(items, 1, 1)).toBe(4);
    expect(nextIndex(items, 4, -1)).toBe(1);
    expect(nextIndex(items, 5, 1)).toBe(1);
    expect(nextIndex(items, 1, -1)).toBe(5);
  });

  it("finds nothing in a menu without actions", () => {
    expect(firstIndex([{ kind: "separator" }, { label: "Off", disabled: true }])).toBe(-1);
  });
});

const menus = () => [...document.querySelectorAll<HTMLElement>(".menu")];
const active = (menu: HTMLElement | undefined) => menu?.querySelector(".menu-item.active .mi-label")?.textContent;
const press = (key: string) =>
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

afterEach(() => {
  closeMenus();
  document.body.replaceChildren();
});

describe("showMenu keyboard", () => {
  it("moves with the arrows and runs the item on Enter", async () => {
    const run = vi.fn();
    const done = showMenu([{ label: "First" }, { kind: "separator" }, { label: "Second", run }], {
      at: { x: 10, y: 10 },
    });
    const [menu] = menus();
    expect(document.activeElement).toBe(menu);
    expect(active(menu)).toBeUndefined();
    press("ArrowDown");
    expect(active(menu)).toBe("First");
    press("ArrowDown");
    expect(active(menu)).toBe("Second");
    press("ArrowDown");
    expect(active(menu)).toBe("First");
    press("End");
    press("Enter");
    expect(await done).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(menus()).toHaveLength(0);
  });

  it("starts on the first item when opened from a button, and Escape closes without running", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchor.focus();
    const run = vi.fn();
    const done = showMenu([{ label: "Only", run }], { at: { anchor } });
    expect(active(menus()[0])).toBe("Only");
    press("Escape");
    expect(await done).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(anchor);
  });

  it("opens a submenu with Right and closes it with Left", async () => {
    const run = vi.fn();
    const done = showMenu(
      [{ label: "Open with", submenu: [{ label: "Editor", run }, { label: "Browser" }] }, { label: "Other" }],
      { at: { x: 0, y: 0 } },
    );
    press("ArrowDown");
    press("ArrowRight");
    expect(menus()).toHaveLength(2);
    expect(active(menus()[1])).toBe("Editor");
    press("ArrowLeft");
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(menus()[0]);
    press("ArrowRight");
    press("Enter");
    expect(await done).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("shows checkmarks, shortcuts in this OS's notation and danger styling", () => {
    void showMenu(
      [
        { label: "Checked", checked: true },
        { label: "Close tab", shortcut: "CmdOrCtrl+W", danger: true },
      ],
      { at: { x: 0, y: 0 } },
    );
    const rows = [...document.querySelectorAll(".menu-item")];
    expect(rows[0]?.getAttribute("role")).toBe("menuitemcheckbox");
    expect(rows[0]?.getAttribute("aria-checked")).toBe("true");
    expect(rows[1]?.classList.contains("danger")).toBe(true);
    expect(rows[1]?.querySelector(".mi-side")?.textContent).toMatch(/^(Ctrl\+W|⌘W)$/);
  });
});

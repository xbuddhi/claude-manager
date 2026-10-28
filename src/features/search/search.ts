// The title-bar search box (#tb-search-slot) and its results dropdown (in #overlay-root). Typing shows
// projects, folders and sessions that match (rank.ts); Up/Down move, Enter opens, Esc clears and goes back
// to the sidebar. Picking leaves a terminal tab for the main view and selects the result in the sidebar; a
// session is also resumed (or switched to when it runs). The dropdown never takes focus from the box.

import { emit, on } from "../../core/bus";
import { h } from "../../core/dom";
import { iconNode } from "../../core/icons";
import { animate, Spring } from "../../core/motion";
import { normPath, samePath } from "../../core/paths";
import { shortcutLabel } from "../../core/platform";
import { profileName } from "../../core/profiles";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { projectsFor, searchSessions } from "../index-data/api";
import { liveDot } from "../live/api";
import { chatIcon, resumeSession, selectSession } from "../sessions/api";
import { nextPick, type PickItem, pickable, type SearchItem, searchItems } from "./rank";
import "./search.css";

const DEBOUNCE_MS = 120;
const BLUR_MS = 150;
const MIN_WIDTH = 460;
const GAP = 6;

/** Sidebar row keys, as the sidebar tree builds them ('g:<lower name>', 'f:<lower path>'). */
export const groupKey = (name: string) => `g:${name.toLowerCase()}`;
export const folderKey = (path: string) => `f:${normPath(path).toLowerCase()}`;

export function placeholder(mac: boolean): string {
  return `Search projects and sessions   (${shortcutLabel("CmdOrCtrl+F", mac)})`;
}

let seq = 0;

export function mountSearch(slot: HTMLElement): void {
  const listId = `search-list-${++seq}`;
  const input = h("input", {
    type: "text",
    class: "search-input",
    placeholder: placeholder(store.get().platform.os === "macos"),
    spellcheck: false,
    autocomplete: "off",
    attrs: {
      role: "combobox",
      "aria-label": "Search projects and sessions",
      "aria-autocomplete": "list",
      "aria-expanded": "false",
      "aria-controls": listId,
    },
  });
  const clear = h("button", {
    type: "button",
    class: "search-clear",
    tabIndex: -1,
    attrs: { "aria-label": "Clear search" },
  });
  clear.append(iconNode("close"));
  clear.hidden = true;
  const glyph = h("span", { class: "search-icon" }, iconNode("search"));
  const field = h("div", { class: "search" }, glyph, input, clear);
  slot.append(field);

  const rows = h("div", { class: "search-rows", id: listId, attrs: { role: "listbox", "aria-label": "Results" } });
  const footer = h("div", { class: "search-foot" }, "↑↓  move      ↵  open      esc  close");
  const pop = h("div", { class: "search-pop" }, rows, footer);
  pop.hidden = true;

  let items: SearchItem[] = [];
  let nodes: Array<HTMLElement | null> = [];
  let sel = -1;
  // sessions whose full text matches, from the backend: asked once per query text, an older answer is ignored
  let textFor = "";
  let textMatches: ReadonlySet<string> = new Set();
  let textSeq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const fade = new Spring(0.16, 1, 0.003, 0);
  const isOpen = () => !pop.hidden;

  function setSel(i: number) {
    nodes[sel]?.classList.remove("on");
    sel = i;
    const node = nodes[i];
    if (node) {
      node.classList.add("on");
      node.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", node.id);
    } else input.removeAttribute("aria-activedescendant");
  }

  function rowFor(item: SearchItem, i: number): HTMLElement {
    if (item.kind === "section")
      return h("div", { class: "search-section", attrs: { role: "presentation" } }, item.title);
    if (item.kind === "empty") return h("div", { class: "search-empty", attrs: { role: "presentation" } }, item.title);
    const ico = h("span", { class: `search-ico${item.kind === "session" ? "" : " accent"}` });
    const live = item.kind === "group" ? 0 : item.live;
    ico.append(live ? liveDot(live === 2 ? 2 : 1) : item.kind === "session" ? chatIcon() : iconNode(item.kind));
    const title = h("span", { class: "search-title" }, item.title);
    const sub = h("span", { class: "search-sub" }, item.sub);
    const text = h("span", { class: `search-text ${item.kind}` }, title, sub);
    const right = h("span", { class: "search-right" }, item.kind === "group" ? "" : item.right);
    const row = h(
      "div",
      { class: `search-item ${item.kind}`, id: `${listId}-${i}`, attrs: { role: "option" } },
      ico,
      text,
      right,
    );
    row.addEventListener("pointermove", () => {
      if (sel !== i) setSel(i);
    });
    row.addEventListener("click", () => pick(item));
    return row;
  }

  function place() {
    const r = field.getBoundingClientRect();
    const width = Math.max(r.width, MIN_WIDTH);
    const left = Math.max(8, Math.min(r.left + (r.width - width) / 2, innerWidth - width - 8));
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(r.bottom + GAP)}px`;
    pop.style.maxHeight = `${Math.max(120, innerHeight - r.bottom - GAP - 12)}px`;
  }

  function show() {
    if (!isOpen()) {
      pop.hidden = false;
      (document.getElementById("overlay-root") ?? document.body).append(pop);
      fade.snap(0.6);
      input.setAttribute("aria-expanded", "true");
    }
    place();
    animate(fade, 1, (v) => {
      pop.style.opacity = String(Math.min(1, v));
    });
  }

  function hide() {
    clearTimeout(timer);
    timer = undefined;
    if (!isOpen()) return;
    pop.hidden = true;
    pop.remove();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function data() {
    const s = store.get();
    return {
      groups: s.settings.groups,
      projects: projectsFor(s.currentProfile, s.index.projects),
      live: s.live,
      liveCwd: s.liveCwd,
      os: s.platform.os,
      profileName,
      unfiltered: s.currentProfile === null && s.settings.hiddenProfiles.length === 0,
      textMatches,
    };
  }

  /** Lists the results for `q` with what is known now. */
  function render(q: string) {
    items = searchItems(q, data());
    nodes = items.map((it, i) => (it.kind === "section" || it.kind === "empty" ? null : rowFor(it, i)));
    rows.replaceChildren(...items.map((it, i) => nodes[i] ?? rowFor(it, i)));
    sel = -1;
    setSel(items.findIndex(pickable));
    show();
  }

  /** Recomputes the results for the text in the box; the full-text matches follow when the backend answers. */
  function update() {
    clearTimeout(timer);
    timer = undefined;
    const q = input.value.trim();
    if (!q) return hide();
    if (q !== textFor) {
      textFor = q;
      textMatches = new Set();
      const seq = ++textSeq;
      void searchSessions(q, store.get().currentProfile).then((ids) => {
        if (seq !== textSeq || !ids.length) return;
        textMatches = new Set(ids);
        if (isOpen() && input.value.trim() === q) render(q);
      });
    }
    render(q);
  }

  /** Closes the dropdown and empties the box. */
  function reset() {
    hide();
    input.value = "";
    clear.hidden = true;
    textFor = "";
    textMatches = new Set();
  }

  function focusSidebar() {
    document.querySelector<HTMLElement>("#sidebar-slot [tabindex='0'], #sidebar-slot .list")?.focus();
  }

  /** Opens the group of `path` if it is collapsed (saved), so the sidebar can show the folder. */
  function expandGroupOf(path: string) {
    const os = store.get().platform.os;
    const groups = settings().groups;
    const g = groups.find((x) => x.folders.some((f) => samePath(f, path, os)));
    if (g?.collapsed) void updateSettings({ groups: groups.map((x) => (x === g ? { ...x, collapsed: false } : x)) });
  }

  function pick(item: PickItem) {
    reset();
    if (store.get().activeTerminal !== null) emit("terminal:show", { id: null });
    if (item.kind === "group") {
      emit("sidebar:select", { key: groupKey(item.name) });
      focusSidebar();
    } else if (item.kind === "folder") {
      expandGroupOf(item.path);
      emit("sidebar:select", { key: folderKey(item.path) });
      focusSidebar();
    } else {
      const s = item.session;
      const project = store.get().index.projects.find((p) => p.sessions.some((x) => x.id === s.id));
      const folder = project?.path ?? s.cwd;
      if (folder) {
        expandGroupOf(folder);
        emit("sidebar:select", { key: folderKey(folder) });
      }
      selectSession(s.id);
      void resumeSession(s); // resumes it, or switches to it when it is already open
    }
  }

  input.addEventListener("input", () => {
    clear.hidden = !input.value;
    clearTimeout(timer);
    timer = setTimeout(update, DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
        if (isOpen()) setSel(nextPick(items, sel, 1));
        else update();
        break;
      case "ArrowUp":
        if (isOpen()) setSel(nextPick(items, sel < 0 ? items.length : sel, -1));
        break;
      case "Enter": {
        if (!isOpen() || timer !== undefined) update();
        const item = items[sel];
        if (pickable(item)) pick(item);
        break;
      }
      case "Escape":
        reset();
        focusSidebar();
        break;
      default:
        return;
    }
    e.preventDefault();
  });
  input.addEventListener("focus", () => {
    clearTimeout(blurTimer);
    if (input.value.trim()) update();
  });
  input.addEventListener("blur", () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (document.activeElement !== input) hide();
    }, BLUR_MS);
  });
  // a click in the dropdown must not take focus from the box
  pop.addEventListener("pointerdown", (e) => e.preventDefault());
  clear.addEventListener("pointerdown", (e) => e.preventDefault());
  clear.addEventListener("click", () => {
    reset();
    input.focus();
  });
  window.addEventListener("pointerdown", (e) => {
    if (isOpen() && e.target instanceof Node && !pop.contains(e.target) && !field.contains(e.target)) hide();
  });
  window.addEventListener("blur", hide);
  window.addEventListener("resize", () => isOpen() && place());

  // new data while the dropdown is open: refresh what it shows
  store.select(
    (s) => [s.index, s.live, s.settings.groups, s.currentProfile] as const,
    () => isOpen() && update(),
    { equals: (a, b) => a.every((v, i) => v === b[i]) },
  );
  // hidden on the picker; it stays on terminal tabs, and picking a result goes back to Home
  store.select(
    (s) => s.screen === "picker",
    (away) => {
      field.classList.toggle("away", away);
      if (away) hide();
    },
    { immediate: true },
  );
  store.select(
    (s) => s.platform.os,
    (os) => {
      input.placeholder = placeholder(os === "macos");
    },
  );

  on("search:focus", () => {
    if (store.get().screen === "picker") return;
    input.focus();
    input.select();
  });
  on("profile:enter", reset);
  // entering a profile from anywhere (picker, avatar menu, new profile) clears the box
  store.select(
    (s) => s.currentProfile,
    () => reset(),
  );
}

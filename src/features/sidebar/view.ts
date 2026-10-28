// The sidebar's "Workspace" card: header with the "+" menu, the load state, and the projects/folders tree on
// ui/list.ts (keyed rows, selection kept across refreshes, keyboard navigation, ARIA tree). The selected row
// sits on a gliding pill (springs 0.3/0.82 for its top and 0.3/0.9 for its height, as the Windows sidebar),
// dimmed while the tree does not have focus.

import type { PathKind } from "../../bindings/PathKind";
import { call } from "../../core/api";
import { on } from "../../core/bus";
import { runCommand } from "../../core/commands";
import { $, h } from "../../core/dom";
import { ago } from "../../core/format";
import { iconNode } from "../../core/icons";
import { animate, autoHideScrollbar, Spring } from "../../core/motion";
import { pathKey } from "../../core/paths";
import { isMac } from "../../core/platform";
import { settings } from "../../core/settings";
import { type AppState, type SidebarSelection, store } from "../../core/store";
import { setSubtitleParts } from "../../core/titlebar";
import { button } from "../../ui/button";
import { createList, type List } from "../../ui/list";
import { showMenu } from "../../ui/menu";
import { toast } from "../../ui/toast";
import { projectsFor, refreshIndex } from "../index-data/api";
import { liveDot } from "../live/api";
import { attachDrag } from "./drag";
import { deleteProject, groupOf, moveFolder, toggleFolders, toggleGroup } from "./groups";
import { addMenu, deleteAllSessions, emptyMenu, folderMenu, groupMenu, newSession } from "./menus";
import { S } from "./strings";
import { buildTree, counts, FOLDERS_KEY, folderKey, folderList, type TreeRow, unlistedPaths } from "./tree";

declare module "../../core/api" {
  interface Commands {
    /** The kind of each path ("dir" | "file" | "missing"), in order; at most 1000 paths. */
    path_kinds: { args: { paths: string[] }; result: PathKind[] };
  }
}

/** Width of the chevron column: a click there opens or closes a project instead of selecting it. */
const CHEVRON_W = 24;

let list: List<TreeRow>;
let status: HTMLElement;
let pill: HTMLElement;
let rows: TreeRow[] = [];
const tops = new Map<string, number>();
let dropKey: string | null = null;
/** The last left press toggled a row (a chevron, heading or "Show more"): its double-click does nothing more. */
let downToggled = false;

// ---------- data ----------

function treeInput(s: AppState) {
  const os = s.platform.os;
  return {
    projects: projectsFor(s.currentProfile, s.index.projects),
    pinned: s.settings.pinned,
    os,
    kinds: s.sidebarKinds,
    groups: s.settings.groups,
    foldersCollapsed: s.settings.ungroupedCollapsed,
    showAll: new Set(s.sidebarShowAll),
    query: "", // search shows its results in its own dropdown; the tree stays as it is
    liveCwd: s.liveCwd,
    ago: (ms: number) => ago(ms),
  };
}

function rebuild() {
  const s = store.get();
  const input = treeInput(s);
  rows = buildTree(input);
  tops.clear();
  let y = 0;
  for (const r of rows) {
    tops.set(r.key, y);
    y += r.height;
  }
  list.setRows(rows);
  // the first selectable row when nothing is selected (as the Windows app's SelectFirst)
  if (!list.selection.selected.length) {
    const first = rows.find(selectable);
    if (first) list.select([first.key]);
  }
  syncSelection();
  placePill();
  renderStatus(s);
  // the picker owns the subtitle while it shows ("Choose a profile"); the 60 s rebuild must not overwrite it
  if (s.index.loaded !== "loading" && s.screen !== "picker") {
    const c = counts(folderList(input));
    setSubtitleParts(S.subtitle(c.sessions, c.folders, s.settings.groups.length));
  }
  void checkKinds(false);
}

const selectable = (r: TreeRow) => r.kind === "group" || r.kind === "folder";
const rowByKey = (key: string | undefined) => rows.find((r) => r.key === key);
const selectedRow = () => rowByKey(list.selection.selected[0]);

function selectionOf(r: TreeRow | undefined): SidebarSelection | null {
  if (r?.kind === "folder" && r.folder) return { kind: "folder", key: r.key, path: r.folder.path, name: r.folder.name };
  if (r?.kind === "group" && r.info) {
    return { kind: "group", key: r.key, name: r.info.name, folders: r.info.folders.map((f) => f.path) };
  }
  return null;
}

/** Publishes the selection as store.sidebarSelection (only when it changed). */
function syncSelection() {
  const next = selectionOf(selectedRow());
  if (JSON.stringify(next) !== JSON.stringify(store.get().sidebarSelection)) store.set({ sidebarSelection: next });
}

// pinned and grouped folders the index does not list: ask the disk whether they are still there
const asked = new Set<string>();
async function checkKinds(force: boolean) {
  const s = store.get();
  const os = s.platform.os;
  const paths = unlistedPaths(
    projectsFor(s.currentProfile, s.index.projects),
    s.settings.pinned,
    s.settings.groups,
    os,
  );
  const todo = (force ? paths : paths.filter((p) => !asked.has(pathKey(p, os)))).slice(0, 1000);
  if (!todo.length) return;
  for (const p of todo) asked.add(pathKey(p, os));
  const res = await call("path_kinds", { paths: todo }, { quiet: true });
  if (!res.ok) return;
  const kinds = { ...store.get().sidebarKinds };
  todo.forEach((p, i) => {
    const k = res.value[i];
    if (k) kinds[pathKey(p, os)] = k;
  });
  store.set({ sidebarKinds: kinds });
}

function renderStatus(s: AppState) {
  status.replaceChildren();
  let text = "";
  if (s.index.loaded === "loading" && !s.index.projects.length) text = S.loading;
  else if (s.index.loaded === "error" && !s.index.projects.length)
    text = `${S.loadError}\n${s.index.error ?? ""}`.trim();
  else if (s.index.loaded === "empty") text = S.noSessions;
  status.hidden = !text;
  if (!text) return;
  status.append(h("div", { class: "sb-status-text" }, text));
  if (s.index.loaded === "error") {
    status.append(button({ label: S.retry, kind: "secondary", onClick: () => void refreshIndex() }));
  }
}

// ---------- the selection pill ----------

const selTop = new Spring(0.3, 0.82, 0.05);
const selH = new Spring(0.3, 0.9, 0.05);
let pillShown = false;

function drawPill() {
  // 1 px of air above and below, like the hover fill
  pill.style.transform = `translateY(${selTop.value + 1}px)`;
  pill.style.height = `${Math.max(0, selH.value - 2)}px`;
}

function placePill() {
  const r = selectedRow();
  const top = r ? tops.get(r.key) : undefined;
  if (!r || top === undefined) {
    pill.hidden = true;
    pillShown = false;
    return;
  }
  pill.hidden = false;
  // a hidden sidebar (a terminal in front) has nothing to glide over: jump there
  if (!pillShown || list.el.offsetParent === null) {
    selTop.snap(top);
    selH.snap(r.height);
    drawPill();
  } else {
    animate(selTop, top, drawPill);
    animate(selH, r.height, drawPill);
  }
  pillShown = true;
}

// ---------- rows ----------

function createRow(r: TreeRow): HTMLElement {
  const el = h("div", { class: `sb-row sb-${r.kind}` });
  if (r.kind === "section") {
    el.append(h("span", { class: "sb-label" }), h("span", { class: "sb-chev" }));
    return el;
  }
  if (r.kind === "more" || r.kind === "hint") {
    el.append(h("span", { class: "sb-label" }));
    return el;
  }
  el.append(
    h("span", { class: "sb-guide" }),
    h("span", { class: "sb-chev" }),
    h("span", { class: "sb-ico" }),
    h("span", { class: "sb-label" }),
    h("span", { class: r.kind === "group" ? "sb-badge" : "sb-detail" }),
    h("span", { class: "sb-live" }),
  );
  return el;
}

/** Sets an icon slot only when the icon changes (rows update on every refresh). */
function setIcon(slot: Element | null, name: string | undefined, factory: () => Element) {
  if (!(slot instanceof HTMLElement) || slot.dataset.icon === (name ?? "")) return;
  slot.dataset.icon = name ?? "";
  slot.replaceChildren(...(name ? [factory()] : []));
}

function updateRow(el: HTMLElement, r: TreeRow) {
  el.style.setProperty("--indent", String(r.indent));
  el.classList.toggle("dim", r.dim);
  el.classList.toggle("nested", r.indent > 0);
  el.classList.toggle("last", r.lastChild);
  el.classList.toggle("drop-target", r.key === dropKey);
  const label = el.querySelector(".sb-label");
  if (label && label.textContent !== r.title) label.textContent = r.title;
  const chev = el.querySelector(".sb-chev");
  setIcon(chev, r.open === undefined ? undefined : r.open ? "chevronDown" : "chevron", () =>
    iconNode(r.open ? "chevronDown" : "chevron"),
  );
  if (r.kind === "section") {
    el.setAttribute("aria-label", r.key === FOLDERS_KEY ? r.title.replace(/\s+·\s+/, ", ") : r.title);
    if (r.open !== undefined) el.setAttribute("aria-expanded", String(r.open));
    return;
  }
  if (r.kind !== "group" && r.kind !== "folder") return;
  setIcon(el.querySelector(".sb-ico"), r.icon, () => iconNode(r.icon ?? "folder"));
  const side = el.querySelector(r.kind === "group" ? ".sb-badge" : ".sb-detail");
  const sideText = r.badge ?? r.detail ?? "";
  if (side && side.textContent !== sideText) side.textContent = sideText;
  const live = el.querySelector<HTMLElement>(".sb-live");
  if (live && live.dataset.level !== String(r.live)) {
    live.dataset.level = String(r.live);
    live.replaceChildren(...(r.live ? [liveDot(r.live)] : []));
  }
  el.setAttribute("aria-level", String(r.indent + 1));
  if (r.kind === "group") el.setAttribute("aria-expanded", String(!!r.open));
  if (r.folder) {
    el.dataset.tip = r.folder.missing ? `${r.folder.path}\nThis folder no longer exists.` : r.folder.path;
  }
}

/** Re-applies the drop highlight to the rendered rows. */
function setDropTarget(r: TreeRow | null) {
  dropKey = r?.key ?? null;
  for (const el of list.el.querySelectorAll<HTMLElement>(".list-row")) {
    el.classList.toggle("drop-target", el.dataset.key === dropKey);
  }
}

const rowOf = (node: Element | null): TreeRow | undefined => {
  const el = node?.closest<HTMLElement>(".list-row");
  return el && list.el.contains(el) ? rowByKey(el.dataset.key) : undefined;
};

// ---------- actions ----------

function toggle(r: TreeRow) {
  if (r.kind === "group" && r.info) void toggleGroup(r.info.name);
  else if (r.kind === "section" && r.key === FOLDERS_KEY) void toggleFolders();
  else if (r.kind === "more" && r.group) {
    const name = r.group.toLowerCase();
    const showAll = store.get().sidebarShowAll;
    store.set({ sidebarShowAll: showAll.includes(name) ? showAll.filter((n) => n !== name) : [...showAll, name] });
  }
}

function activate(r: TreeRow) {
  if (r.kind !== "folder") return toggle(r);
  if (!r.folder) return;
  if (r.folder.missing) {
    toast("This folder no longer exists.");
    return;
  }
  newSession(r.folder.path);
}

function remove(r: TreeRow | undefined) {
  if (r?.kind === "group" && r.info) void deleteProject(r.info.name);
  else if (r?.kind === "folder" && r.folder) void deleteAllSessions(r.folder);
}

function openMenu(r: TreeRow | undefined, x: number, y: number) {
  const at = { x, y };
  if (r?.kind === "folder" && r.folder) void showMenu(folderMenu(r.folder), { at, label: r.title });
  else if (r?.kind === "group" && r.info) void showMenu(groupMenu(r.info, at), { at, label: r.title });
  else void showMenu(emptyMenu(), { at });
}

/** Selects a row by key, opening its project (and its full folder list) when it is inside one. */
function selectKey(key: string) {
  const os = store.get().platform.os;
  let wanted = key;
  if (key.startsWith("f:")) {
    const path = key.slice(2);
    wanted = folderKey(path, os);
    const g = groupOf(settings().groups, path, os);
    if (g) {
      if (g.collapsed) void toggleGroup(g.name, false);
      const name = g.name.toLowerCase();
      const showAll = store.get().sidebarShowAll;
      if (!showAll.includes(name)) store.set({ sidebarShowAll: [...showAll, name] });
    }
  }
  // the settings and state changes above rebuilt the rows synchronously
  if (!rowByKey(wanted)) return;
  list.select([wanted]);
  list.scrollToKey(wanted);
  list.focus();
  syncSelection();
  placePill();
}

function onKey(e: KeyboardEvent) {
  const r = selectedRow();
  const del = e.key === "Delete" || (isMac() && e.key === "Backspace" && e.metaKey);
  if (del && r) {
    e.preventDefault();
    remove(r);
  } else if (e.key === "ArrowRight" && r?.kind === "group" && !r.open) {
    e.preventDefault();
    toggle(r);
  } else if (e.key === "ArrowLeft" && r?.kind === "group" && r.open) {
    e.preventDefault();
    toggle(r);
  } else if (e.key === "ArrowLeft" && r?.kind === "folder" && r.group) {
    e.preventDefault();
    selectKey(`g:${r.group.toLowerCase()}`);
  } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
    e.preventDefault();
    const el = r ? list.el.querySelector<HTMLElement>(`.list-row[data-key="${CSS.escape(r.key)}"]`) : null;
    const box = (el ?? list.el).getBoundingClientRect();
    openMenu(r, box.left + 24, box.top + Math.min(box.height, 32));
  }
}

/** Left mouse button on a heading, a "Show more" row or a project's chevron toggles it and selects nothing. */
function onMouseDown(e: MouseEvent) {
  downToggled = false;
  if (e.button !== 0) return;
  const r = rowOf(e.target as Element);
  if (!r) return;
  const el = (e.target as Element).closest<HTMLElement>(".list-row");
  const x = el ? e.clientX - el.getBoundingClientRect().left : CHEVRON_W;
  const chevron = r.kind === "group" && x < CHEVRON_W;
  if (r.kind === "hint") {
    e.stopPropagation();
  } else if (r.kind === "more" || r.kind === "section" || chevron) {
    e.stopPropagation();
    downToggled = true;
    if (r.kind !== "section" || r.open !== undefined) toggle(r);
  }
}

// ---------- mount ----------

export function mountView(slot: HTMLElement): void {
  const add = button({ icon: "plus", kind: "plain", title: S.addTip });
  add.classList.add("sb-add");
  add.addEventListener("click", () => void showMenu(addMenu(), { at: { anchor: add, align: "end" }, label: S.addTip }));
  const hide = button({ icon: "sidebar", kind: "plain", title: "Hide sidebar  (Ctrl+S)" });
  hide.classList.add("sb-add");
  hide.addEventListener("click", () => runCommand("sidebar:toggle"));
  const head = h(
    "header",
    { class: "sb-head" },
    h("span", { class: "sb-title" }, S.title),
    h("span", { class: "sb-head-actions" }, add, hide),
  );
  status = h("div", { class: "sb-status", attrs: { role: "status" } });
  status.hidden = true;

  list = createList<TreeRow>({
    label: S.treeLabel,
    role: "tree",
    key: (r) => r.key,
    height: (r) => r.height,
    selectable,
    create: createRow,
    update: (el, r) => updateRow(el, r),
    onSelectionChange: () => {
      syncSelection();
      placePill();
    },
    onActivate: (r, e) => {
      if (e.type === "dblclick" && downToggled) return;
      activate(r);
    },
    onContextMenu: (r, e) => openMenu(r, e.clientX, e.clientY),
  });
  list.el.classList.add("sb-tree");
  pill = h("div", { class: "sb-pill", attrs: { "aria-hidden": "true" } });
  pill.hidden = true;
  $(".list-inner", list.el).prepend(pill);
  autoHideScrollbar(list.el);

  list.el.addEventListener("mousedown", onMouseDown, true);
  list.el.addEventListener("keydown", onKey);
  list.el.addEventListener("contextmenu", (e) => {
    if (rowOf(e.target as Element)) return; // the list opens the row's menu
    e.preventDefault();
    openMenu(undefined, e.clientX, e.clientY);
  });
  attachDrag<TreeRow>({
    el: list.el,
    rowAt: rowOf,
    title: (r) => r.title,
    canDrag: (r) => r.kind === "folder" && r.draggable,
    // a project takes folders from elsewhere; FOLDERS takes folders out of a project
    canDrop: (src, dst) =>
      dst.acceptsDrop && (dst.kind === "group" ? dst.info?.name !== src.group : src.group !== undefined),
    setTarget: setDropTarget,
    onDrop: (src, dst) => {
      if (src.folder) void moveFolder(src.folder.path, dst.kind === "group" ? (dst.info?.name ?? null) : null);
    },
  });

  slot.replaceChildren(head, status, list.el);

  store.select(
    (s) =>
      [
        s.index,
        s.currentProfile,
        s.settings.pinned,
        s.settings.groups,
        s.settings.ungroupedCollapsed,
        s.liveCwd,
        s.platform.os,
        s.sidebarShowAll,
        s.sidebarKinds,
        s.profiles,
      ] as const,
    rebuild,
    { equals: (a, b) => a.every((v, i) => Object.is(v, b[i])), immediate: true },
  );
  // the pill measures nothing, but it should not glide in from where it was while the sidebar was hidden
  store.select(
    (s) => s.activeTerminal === null,
    (home) => {
      if (home) {
        pillShown = false;
        placePill();
      }
    },
  );
  on("sidebar:select", ({ key }) => selectKey(key));
  // "5m ago" moves on; folders may have been deleted while the app was in the background
  setInterval(() => {
    if (!document.hidden) rebuild();
  }, 60_000);
  window.addEventListener("focus", () => void checkKinds(true));
}

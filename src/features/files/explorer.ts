// A file tree of one folder with its bar (new file, new folder, show ignored, collapse) and the file
// operations: rename, move by dragging onto a folder, duplicate, move to the trash. Used by the Files view and
// by the panel beside a terminal, each with its own tree. Entries .gitignore leaves out are hidden unless
// shown from the bar. While shown, the open folders are read again every 4 s and when the app comes back to
// the front.

import type { FileEntry } from "../../bindings/FileEntry";
import type { FolderListing } from "../../bindings/FolderListing";
import { call } from "../../core/api";
import { cssEsc, h } from "../../core/dom";
import { leaf } from "../../core/format";
import { iconNode } from "../../core/icons";
import { samePath } from "../../core/paths";
import { store } from "../../core/store";
import { button } from "../../ui/button";
import { ask, input } from "../../ui/dialog";
import { createList } from "../../ui/list";
import { type MenuItem, showMenu } from "../../ui/menu";
import { copyText, openInCode, reveal, revealLabel, trashName } from "../os/api";
import { attachDrag } from "../sidebar/api";
import "./api";
import "./files.css";
import { fileType } from "./filetypes";
import { collapseIcon, eyeIcon, eyeOffIcon, newFileIcon, newFolderIcon } from "./icons";
import { absPath, canMoveInto, flatten, isUnder, joinRel, nameOf, parentRel, renamed, type TreeRow } from "./tree";

const POLL_MS = 4000;
const ROW = 24;
const INDENT = 14;
const IGNORED_KEY = "files.showIgnored";

type EntryRow = Extract<TreeRow, { kind: "entry" }>;
/** What a drag can drop on: a row, or the place outside the tree (`ExplorerOptions.drop`). */
type DragRow = TreeRow | { kind: "outside"; key: string };
const OUTSIDE: DragRow = { kind: "outside", key: "\0outside" };

export function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // only a convenience
  }
}

export interface ExplorerOptions {
  /** Shown when there is no folder. */
  noRoot: string;
  /** A file was selected (`rel` relative to the root). */
  onSelectFile?(rel: string): void;
  /** Entries moved or renamed; paths under `from` are now under `to`. */
  onRenamed?(from: string, to: string): void;
  /** An entry went to the trash. */
  onTrashed?(rel: string): void;
  /** More items for an entry's menu, at the top. */
  menuItems?(abs: string): MenuItem[];
  /** A place outside the tree entries can be dragged onto (e.g. the terminal). */
  drop?: {
    /** Whether `node` is in that place. */
    at(node: Element | null): boolean;
    /** Marks the place while a drag is over it. */
    mark(on: boolean): void;
    run(abs: string): void;
  };
}

export interface Explorer {
  el: HTMLElement;
  /** The folder shown, and the folders the bar may switch to (a project's folders). */
  setRoot(root: string | null, choices?: string[]): void;
  root(): string | null;
  /** Polls only while shown. */
  setShown(shown: boolean): void;
  refresh(): Promise<void>;
  /** Opens the folders above `rel` and selects it (a file is reported to onSelectFile). */
  showPath(rel: string): Promise<void>;
}

export function createExplorer(opts: ExplorerOptions): Explorer {
  const st = {
    shown: false,
    root: null as string | null,
    choices: [] as string[],
    listings: new Map<string, FolderListing>(),
    expanded: new Set<string>(),
    seq: 0,
    /** An operation is running: the poll waits for it. */
    busy: false,
  };
  const os = () => store.get().platform.os;
  const showIgnored = () => loadPref(IGNORED_KEY) === "1";

  const bar = h("div", { class: "fm-bar" });
  const note = h("div", { class: "fm-note" });
  let dropEl: HTMLElement | null = null;

  const list = createList<TreeRow>({
    label: "Files",
    role: "tree",
    key: (r) => r.key,
    height: () => ROW,
    selectable: (r) => r.kind === "entry",
    create: createRow,
    update: updateRow,
    onSelectionChange: (keys) => {
      const row = rowOf(keys[0]);
      if (row && !row.entry.dir) opts.onSelectFile?.(row.key);
    },
    onActivate: (row, e) => {
      if (row.kind !== "entry") return;
      if (row.entry.dir) {
        if (e.type === "keydown") toggle(row);
      } else if (e.type === "dblclick" && st.root) void openInCode([absPath(st.root, row.key)]);
    },
    onContextMenu: (row, e) => {
      if (row.kind === "entry") rowMenu(row, { x: e.clientX, y: e.clientY });
    },
  });
  list.el.classList.add("fm-tree");
  const el = h("div", { class: "fm-explorer" }, bar, note, list.el);

  function rowOf(key: string | undefined): EntryRow | undefined {
    const row = list.rows().find((r) => r.key === key);
    return row?.kind === "entry" ? row : undefined;
  }

  /** The folder new items go to for a row: the folder itself, or a file's folder. */
  function folderFor(row: TreeRow | undefined): string {
    if (row?.kind !== "entry") return "";
    return row.entry.dir ? row.key : parentRel(row.key);
  }

  // ---------- the tree ----------

  function showNote(text: string | null) {
    note.hidden = text === null;
    note.textContent = text ?? "";
    list.el.hidden = text !== null;
  }

  function renderTree() {
    const rows = flatten(st.listings, st.expanded);
    list.setRows(rows);
    showNote(
      st.listings.has("") && !rows.length
        ? showIgnored()
          ? "This folder is empty."
          : "Nothing here, or only ignored files."
        : null,
    );
  }

  /** Folders whose entries are on screen: open, with every folder above open too. */
  function shownFolders(): string[] {
    const out = [""];
    for (const d of st.expanded) {
      let up = parentRel(d);
      let open = true;
      while (up && open) {
        open = st.expanded.has(up);
        up = parentRel(up);
      }
      if (open) out.push(d);
    }
    return out;
  }

  /** Reads the root and the shown folders again. */
  async function load() {
    if (!st.shown) return;
    const seq = ++st.seq;
    const root = st.root;
    renderBar();
    if (!root) {
      list.setRows([]);
      return showNote(opts.noRoot);
    }
    const dirs = shownFolders();
    const ignored = showIgnored();
    const results = await Promise.all(dirs.map((dir) => call("files_list", { root, dir, ignored }, { quiet: true })));
    if (seq !== st.seq) return;
    const top = results[0];
    if (!top?.ok) {
      st.listings = new Map();
      list.setRows([]);
      return showNote(top?.error.message ?? "");
    }
    const next = new Map<string, FolderListing>();
    dirs.forEach((dir, i) => {
      const res = results[i];
      if (res?.ok) next.set(dir, res.value);
      else st.expanded.delete(dir);
    });
    st.listings = next;
    renderTree();
  }

  async function expand(key: string) {
    const root = st.root;
    if (!root) return;
    st.expanded.add(key);
    const res = await call("files_list", { root, dir: key, ignored: showIgnored() });
    if (root !== st.root) return;
    if (res.ok) st.listings.set(key, res.value);
    else st.expanded.delete(key);
    renderTree();
  }

  function collapse(key: string) {
    st.expanded.delete(key);
    renderTree();
  }

  function toggle(row: EntryRow) {
    if (!row.entry.dir) return;
    if (row.open) collapse(row.key);
    else void expand(row.key);
  }

  function selectKey(key: string) {
    list.select([key]);
    list.scrollToKey(key);
  }

  async function showPath(rel: string) {
    for (let up = parentRel(rel); up; up = parentRel(up)) st.expanded.add(up);
    await load();
    const row = rowOf(rel);
    if (!row) return;
    selectKey(rel);
    if (!row.entry.dir) opts.onSelectFile?.(rel);
  }

  // ---------- operations ----------

  async function run<T>(op: () => Promise<T>): Promise<T> {
    st.busy = true;
    try {
      return await op();
    } finally {
      st.busy = false;
    }
  }

  async function newItem(dir: string, folder: boolean) {
    const root = st.root;
    if (!root) return;
    const kind = folder ? "New folder" : "New file";
    const name = (
      await input(`${kind}\nIn ${dir || leaf(root)}`, {
        placeholder: folder ? "Folder name" : "File name",
        okLabel: "Create",
      })
    )?.trim();
    if (!name) return;
    const path = joinRel(dir, name);
    const res = await run(() => call("files_create", { root, path, folder }));
    if (res.ok) await showPath(path);
  }

  async function rename(row: EntryRow) {
    const name = (await input(`Rename\n${row.key}`, { value: row.entry.name, okLabel: "Rename" }))?.trim();
    if (!name || name === row.entry.name) return;
    await move(row.key, joinRel(parentRel(row.key), name));
  }

  async function move(from: string, to: string) {
    const root = st.root;
    if (!root) return;
    const res = await run(() => call("files_rename", { root, from, to }));
    if (!res.ok) return;
    st.expanded = new Set([...st.expanded].map((d) => renamed(d, from, to)));
    opts.onRenamed?.(from, to);
    await showPath(to);
  }

  async function duplicate(rel: string) {
    const root = st.root;
    if (!root) return;
    const res = await run(() => call("files_duplicate", { root, path: rel }));
    if (res.ok) await showPath(res.value);
  }

  async function trash(row: EntryRow) {
    const root = st.root;
    if (!root) return;
    const what = row.entry.dir ? "The folder and everything in it go" : "It goes";
    const ok = await ask(
      `Move ${row.entry.name} to the ${trashName()}?\n${what} to the ${trashName()}, where you can restore it.`,
      `Move to ${trashName()}`,
      "warning",
    );
    if (!ok) return;
    const res = await run(() => call("files_trash", { root, path: row.key }));
    if (!res.ok) return;
    st.expanded = new Set([...st.expanded].filter((d) => !isUnder(d, row.key)));
    opts.onTrashed?.(row.key);
    await load();
  }

  function rowMenu(row: EntryRow, at: { x: number; y: number }) {
    const root = st.root;
    if (!root) return;
    const abs = absPath(root, row.key);
    const dir = folderFor(row);
    const extra = opts.menuItems?.(abs) ?? [];
    const items: MenuItem[] = [
      ...extra,
      ...(extra.length ? [{ kind: "separator" } as const] : []),
      { label: "Open in VS Code", icon: "vscode", run: () => void openInCode([abs]) },
      { label: revealLabel(), icon: "folder", run: () => void reveal(abs) },
      { kind: "separator" },
      { label: "New File…", icon: newFileIcon(), run: () => void newItem(dir, false) },
      { label: "New Folder…", icon: newFolderIcon(), run: () => void newItem(dir, true) },
      { kind: "separator" },
      { label: "Rename…", shortcut: "F2", run: () => void rename(row) },
    ];
    if (!row.entry.dir) items.push({ label: "Duplicate", icon: "copy", run: () => void duplicate(row.key) });
    items.push(
      { kind: "separator" },
      { label: "Copy Path", run: () => void copyText(abs) },
      { label: "Copy Relative Path", run: () => void copyText(row.key) },
      { kind: "separator" },
      { label: `Move to ${trashName()}`, icon: "trash", danger: true, run: () => void trash(row) },
    );
    void showMenu(items, { at, label: row.entry.name });
  }

  function rootMenu(at: { x: number; y: number }) {
    if (!st.root) return;
    void showMenu(
      [
        { label: "New File…", icon: newFileIcon(), run: () => void newItem("", false) },
        { label: "New Folder…", icon: newFolderIcon(), run: () => void newItem("", true) },
        { kind: "separator" },
        { label: "Show Ignored Files", checked: showIgnored(), run: toggleIgnored },
        { label: "Refresh", icon: "refresh", run: () => void load() },
      ],
      { at, label: "Files" },
    );
  }

  function toggleIgnored() {
    savePref(IGNORED_KEY, showIgnored() ? "0" : "1");
    void load();
  }

  // ---------- rendering ----------

  function renderBar() {
    const items: HTMLElement[] = [];
    const root = st.root;
    if (root && st.choices.length > 1) {
      const pick = button({ label: leaf(root), icon: "folder", kind: "plain", title: "Folder of this project" });
      pick.addEventListener("click", () => {
        void showMenu(
          st.choices.map((f) => ({
            label: leaf(f),
            detail: f,
            checked: samePath(f, root, os()),
            run: () => api.setRoot(f, st.choices),
          })),
          { at: { anchor: pick }, label: "Folder" },
        );
      });
      items.push(pick);
    } else if (root) {
      const name = h("span", { class: "fm-bar-label" }, leaf(root));
      name.dataset.tip = root;
      items.push(name);
    }
    items.push(h("span", { class: "fm-bar-gap" }));
    if (root) {
      const selected = () => folderFor(rowOf(list.selection.selected[0]));
      const on = showIgnored();
      const ignored = button({
        icon: on ? eyeIcon() : eyeOffIcon(),
        kind: "plain",
        title: on ? "Hide ignored files" : "Show ignored files",
        onClick: toggleIgnored,
      });
      ignored.setAttribute("aria-pressed", String(on));
      items.push(
        button({
          icon: newFileIcon(),
          kind: "plain",
          title: "New file",
          onClick: () => void newItem(selected(), false),
        }),
        button({
          icon: newFolderIcon(),
          kind: "plain",
          title: "New folder",
          onClick: () => void newItem(selected(), true),
        }),
        ignored,
        button({
          icon: collapseIcon(),
          kind: "plain",
          title: "Collapse folders",
          onClick: () => {
            st.expanded.clear();
            renderTree();
          },
        }),
      );
    }
    bar.replaceChildren(...items);
  }

  function setDrop(dir: string | null) {
    dropEl?.classList.remove("drop-target");
    dropEl = null;
    if (dir === null) return;
    dropEl = dir === "" ? list.el : list.el.querySelector<HTMLElement>(`.list-row[data-key="${cssEsc(dir)}"]`);
    dropEl?.classList.add("drop-target");
  }

  // ---------- events ----------

  // a click on a folder opens or closes it
  list.el.addEventListener("click", (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    const row = rowOf((e.target as Element).closest<HTMLElement>(".list-row")?.dataset.key);
    if (row?.entry.dir) toggle(row);
  });
  list.el.addEventListener("contextmenu", (e) => {
    if ((e.target as Element).closest(".list-row")) return;
    e.preventDefault();
    rootMenu({ x: e.clientX, y: e.clientY });
  });
  list.el.addEventListener("keydown", (e) => {
    const row = rowOf(list.selection.focus ?? undefined);
    if (!row) return;
    const mac = os() === "macos";
    if (e.key === "ArrowRight" && row.entry.dir && !row.open) void expand(row.key);
    else if (e.key === "ArrowLeft" && row.open) collapse(row.key);
    else if (e.key === "ArrowLeft" && parentRel(row.key)) selectKey(parentRel(row.key));
    else if (e.key === "F2") void rename(row);
    else if (e.key === "Delete" || (mac && e.key === "Backspace" && e.metaKey)) void trash(row);
    else return;
    e.preventDefault();
  });
  const outside = opts.drop;
  attachDrag<DragRow>({
    el: list.el,
    reach: outside ? document.documentElement : undefined,
    rowAt: (node) => (outside?.at(node) ? OUTSIDE : rowOf(node?.closest<HTMLElement>(".list-row")?.dataset.key)),
    title: (row) => (row.kind === "entry" ? row.entry.name : ""),
    canDrag: (row) => row.kind === "entry",
    canDrop: (src, dst) => dst.kind === "outside" || canMoveInto(src.key, folderFor(dst as TreeRow)),
    setTarget: (dst) => {
      outside?.mark(dst?.kind === "outside");
      setDrop(dst && dst.kind !== "outside" ? folderFor(dst) : null);
    },
    onDrop: (src, dst) => {
      if (dst.kind === "outside") {
        if (st.root) outside?.run(absPath(st.root, src.key));
      } else void move(src.key, joinRel(folderFor(dst), nameOf(src.key)));
    },
  });
  window.addEventListener("focus", () => void load());
  setInterval(() => {
    if (st.shown && !st.busy && !document.hidden) void load();
  }, POLL_MS);

  const api: Explorer = {
    el,
    setRoot(root, choices = []) {
      st.choices = choices;
      if (root !== null && st.root !== null && samePath(root, st.root, os())) {
        renderBar();
        return;
      }
      st.root = root;
      st.listings = new Map();
      st.expanded = new Set();
      st.seq++;
      list.setRows([]);
      void load();
    },
    root: () => st.root,
    setShown(shown) {
      if (shown === st.shown) return;
      st.shown = shown;
      if (shown) void load();
    },
    refresh: load,
    showPath,
  };
  return api;
}

function createRow(): HTMLElement {
  return h(
    "div",
    { class: "fm-row" },
    h("span", { class: "fm-chev" }),
    h("span", { class: "fm-ico" }),
    h("span", { class: "fm-name" }),
  );
}

/** Sets `slot`'s icon only when it changes: a row is updated on mousedown, and WebKit sends no click when
 * the node pressed was replaced before the button came up. */
function setIcon(slot: HTMLElement, name: "chevron" | "chevronDown" | "folder" | "file" | null) {
  const want = name ?? "";
  if (slot.dataset.icon === want) return;
  slot.dataset.icon = want;
  slot.replaceChildren(...(name ? [iconNode(name)] : []));
}

/** A file's type badge (filetypes.ts), or the plain file icon; replaced only when it changes, as above. */
function setFileIcon(slot: HTMLElement, name: string) {
  const type = fileType(name);
  const want = type ? `${type.label} ${type.color}` : "file";
  if (slot.dataset.icon === want) return;
  slot.dataset.icon = want;
  if (!type) {
    slot.replaceChildren(iconNode("file"));
    return;
  }
  const badge = h("span", { class: "fm-badge", attrs: { "aria-hidden": "true" } }, type.label);
  badge.style.color = `var(${type.color})`;
  slot.replaceChildren(badge);
}

function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

function updateRow(el: HTMLElement, row: TreeRow) {
  const [chev, ico, name] = el.children as unknown as [HTMLElement, HTMLElement, HTMLElement];
  el.style.paddingLeft = `${6 + row.depth * INDENT}px`;
  if (row.kind === "more") {
    el.classList.add("fm-more");
    setIcon(chev, null);
    setIcon(ico, null);
    setText(name, `${row.count} more not listed`);
    return;
  }
  const e: FileEntry = row.entry;
  el.classList.toggle("fm-dir", e.dir);
  el.classList.toggle("fm-ignored", e.ignored);
  el.classList.toggle("fm-link", e.link);
  if (e.dir) el.setAttribute("aria-expanded", String(row.open));
  else el.removeAttribute("aria-expanded");
  setIcon(chev, e.dir ? (row.open ? "chevronDown" : "chevron") : null);
  if (e.dir) setIcon(ico, "folder");
  else setFileIcon(ico, e.name);
  setText(name, e.name);
  if (e.link) el.dataset.tip = `${e.name} (link)`;
  else delete el.dataset.tip;
}

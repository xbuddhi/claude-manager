// The Memory view: on the left the memory files for the selected folder, grouped from broadest (the
// profile's) to most specific (auto memory); on the right the chosen one, read-only, with Open in VS Code,
// Reveal, and Create for a CLAUDE.md that does not exist yet. A project's folders and the profile can be
// switched from the bar above the list; the profile follows the one in view unless switched here.

import type { MemoryFile } from "../../bindings/MemoryFile";
import type { MemoryLevel } from "../../bindings/MemoryLevel";
import type { Profile } from "../../bindings/Profile";
import { call } from "../../core/api";
import { on } from "../../core/bus";
import { h } from "../../core/dom";
import { leaf } from "../../core/format";
import { iconNode } from "../../core/icons";
import { samePath } from "../../core/paths";
import { profiles } from "../../core/profiles";
import { store } from "../../core/store";
import { button } from "../../ui/button";
import { showMenu } from "../../ui/menu";
import { openInCode, reveal, revealLabel } from "../os/api";
import "./api";
import { renderMarkdown } from "./markdown";
import "./memory.css";

const GROUPS: Array<{ title: string; levels: MemoryLevel[] }> = [
  { title: "Global", levels: ["user", "rules"] },
  { title: "Folders above", levels: ["parent"] },
  { title: "This folder", levels: ["project", "local"] },
  { title: "Subfolders", levels: ["subfolder"] },
  { title: "Auto memory", levels: ["auto"] },
];

/** Missing files that can be created here; Claude Code writes the rest itself. */
const CREATABLE: ReadonlySet<MemoryLevel> = new Set(["user", "project", "local"]);

const st = {
  visible: false,
  /** Folder picked among a project's folders. */
  pick: null as string | null,
  /** Profile picked here; null = the one in view. */
  profile: null as string | null,
  folder: null as string | null,
  files: [] as MemoryFile[],
  selected: null as string | null,
  seq: 0,
  /** Groups folded to their title; Global starts folded (it is the same for every folder). */
  folded: new Set<string>(["Global"]),
};

let bar: HTMLElement;
let list: HTMLElement;
let head: HTMLElement;
let content: HTMLElement;
/** The document on screen and what it was drawn from, to skip drawing it again unchanged. */
let shown: { path: string; text: string; el: HTMLElement } | null = null;

function selectionFolders(): string[] {
  const sel = store.get().sidebarSelection;
  if (!sel) return [];
  return sel.kind === "group" ? (sel.folders ?? []) : sel.path ? [sel.path] : [];
}

/** The profile shown: picked here, else the one in view, else the default one. */
function profile(): Profile | undefined {
  const all = profiles();
  const want = st.profile ?? store.get().currentProfile;
  return all.find((p) => p.dir === want) ?? all.find((p) => p.isDefault) ?? all[0];
}

/** The folder a path is in. */
function parentOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

/** The home folder: the one holding the default profile's `.claude` (null when that is elsewhere). */
function home(): string | null {
  const dir = profiles().find((p) => p.isDefault)?.dir;
  return dir && /[\\/]\.claude$/.test(dir) ? parentOf(dir) : null;
}

/** `path` with the home folder written as "~". */
export function tilde(path: string, homeDir = home()): string {
  if (!homeDir || !path.toLowerCase().startsWith(homeDir.toLowerCase())) return path;
  const rest = path.slice(homeDir.length);
  return rest === "" ? "~" : /^[\\/]/.test(rest) ? `~${rest}` : path;
}

/** Text of a file's row: its name and a line saying where it applies. */
function describe(f: MemoryFile, folder: string): { name: string; where: string } {
  const name = leaf(f.path);
  switch (f.level) {
    case "user":
      return { name: "Global CLAUDE.md", where: `${tilde(parentOf(f.path))} · every project` };
    case "rules":
      return { name, where: `${tilde(parentOf(f.path))} · every project` };
    case "parent":
      return { name, where: tilde(parentOf(f.path)) };
    case "project":
      return {
        name: /[\\/]\.claude[\\/]CLAUDE\.md$/.test(f.path) ? ".claude/CLAUDE.md" : name,
        where: "shared through git",
      };
    case "local":
      return { name, where: "only you · not committed" };
    case "subfolder": {
      const rel = f.path.slice(folder.length).replace(/^[\\/]/, "");
      return { name: rel, where: "loaded when Claude works there" };
    }
    case "auto":
      return { name, where: name === "MEMORY.md" ? "index Claude keeps" : "a fact Claude saved" };
  }
}

function message(text: string) {
  st.files = [];
  st.selected = null;
  list.replaceChildren(h("div", { class: "mem-empty-list" }, text));
  head.replaceChildren();
  content.replaceChildren();
}

function renderBar() {
  const p = profile();
  const folders = selectionFolders();
  const items: HTMLElement[] = [];
  if (folders.length > 1 && st.folder) {
    const pickFolder = button({
      label: leaf(st.folder),
      icon: "folder",
      kind: "plain",
      title: "Folder of this project",
    });
    pickFolder.addEventListener("click", () => {
      void showMenu(
        folders.map((f) => ({
          label: leaf(f),
          detail: f,
          checked: f === st.folder,
          run: () => {
            st.pick = f;
            void refresh();
          },
        })),
        { at: { anchor: pickFolder }, label: "Folder" },
      );
    });
    items.push(pickFolder);
  }
  const all = profiles();
  if (p && all.length > 1) {
    const pickProfile = button({ label: `${p.name} profile`, kind: "plain", title: "Profile whose memory is shown" });
    pickProfile.addEventListener("click", () => {
      void showMenu(
        all.map((q) => ({
          label: q.name,
          detail: q.email ?? undefined,
          checked: q.dir === p.dir,
          run: () => {
            st.profile = q.dir;
            void refresh();
          },
        })),
        { at: { anchor: pickProfile }, label: "Profile" },
      );
    });
    items.push(pickProfile);
  } else if (p) items.push(h("span", { class: "mem-bar-label" }, `${p.name} profile`));
  bar.replaceChildren(...items);
}

function renderList() {
  const folder = st.folder ?? "";
  const out: HTMLElement[] = [];
  for (const g of GROUPS) {
    const files = st.files.filter((f) => g.levels.includes(f.level));
    if (!files.length) continue;
    const folded = st.folded.has(g.title);
    out.push(
      h(
        "button",
        {
          type: "button",
          class: "mem-group",
          attrs: { "aria-expanded": String(!folded) },
          onclick: () => {
            if (folded) st.folded.delete(g.title);
            else st.folded.add(g.title);
            renderList();
          },
        },
        iconNode(folded ? "chevron" : "chevronDown"),
        h("span", {}, folded ? `${g.title} · ${files.filter((f) => f.exists).length}` : g.title),
      ),
    );
    if (folded) continue;
    for (const f of files) {
      const { name, where } = describe(f, folder);
      const row = h(
        "button",
        {
          type: "button",
          class: `mem-row${f.exists ? "" : " missing"}${f.path === st.selected ? " selected" : ""}`,
          attrs: { "aria-current": f.path === st.selected ? "true" : false },
          onclick: () => select(f.path),
        },
        h("span", { class: "mem-row-name" }, name),
        h("span", { class: "mem-row-where" }, f.exists ? where : `${where} · not created`),
      );
      row.dataset.tip = f.path;
      out.push(row);
    }
  }
  list.replaceChildren(...out);
}

/** `rel` (a link in a file) against the folder `dir`, with "." and ".." worked out, in `dir`'s separators. */
export function joinPath(dir: string, rel: string): string {
  if (/^([a-zA-Z]:)?[\\/]/.test(rel)) return rel;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const out: string[] = [];
  for (const part of `${dir}${sep}${rel}`.split(/[\\/]/)) {
    if (part === ".") continue;
    if (part === ".." && out.length > 1) out.pop();
    else if (part !== "..") out.push(part);
  }
  return out.join(sep);
}

/** A clicked link: https opens in the browser, another memory file opens here; anything else is ignored. */
function openLink(href: string, from: string) {
  if (/^https:\/\//i.test(href)) {
    void call("open_url_https", { url: href });
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
  const target = joinPath(parentOf(from), decodeURI(href.split("#")[0] ?? ""));
  const os = store.get().platform.os;
  const f = st.files.find((x) => samePath(x.path, target, os));
  if (f) void select(f.path);
}

async function select(path: string) {
  // the same file read again (the app came back to the front): stay where the reader was
  const keepScroll = st.selected === path ? content.scrollTop : 0;
  st.selected = path;
  renderList();
  const f = st.files.find((x) => x.path === path);
  const p = profile();
  if (!f || !p || !st.folder) return;
  const folder = st.folder;
  const seq = ++st.seq;
  const actions: HTMLElement[] = [];
  if (f.exists) {
    const code = button({ icon: "vscode", kind: "plain", title: "Open in VS Code" });
    code.addEventListener("click", () => void openInCode([f.path]));
    const show = button({ icon: "folder", kind: "plain", title: revealLabel() });
    show.addEventListener("click", () => void reveal(f.path));
    actions.push(code, show);
  } else if (CREATABLE.has(f.level)) {
    const create = button({ label: "Create", icon: "plus", kind: "primary" });
    create.addEventListener("click", async () => {
      const res = await call("memory_create", { profile: p.dir, folder, path: f.path });
      if (!res.ok) return;
      await refresh();
      void openInCode([f.path]);
    });
    actions.push(create);
  }
  head.replaceChildren(
    h("span", { class: "mem-path selectable" }, tilde(f.path)),
    h("span", { class: "mem-actions" }, ...actions),
  );
  if (!f.exists) {
    content.replaceChildren(
      h(
        "div",
        { class: "mem-empty" },
        CREATABLE.has(f.level)
          ? "Not created yet. Create it to give Claude instructions at this level."
          : "Claude Code writes this file itself.",
      ),
    );
    return;
  }
  const res = await call("memory_read", { profile: p.dir, folder, path: f.path }, { quiet: true });
  if (seq !== st.seq) return;
  if (!res.ok) {
    content.replaceChildren(h("div", { class: "mem-empty" }, res.error.message));
    return;
  }
  const text = res.value.trim() ? res.value : "(empty)";
  // read again unchanged: the document stays as it is
  if (shown?.path === f.path && shown.text === text && content.firstElementChild === shown.el) return;
  const el = await renderMarkdown(text, (href) => openLink(href, f.path));
  if (seq !== st.seq) return;
  shown = { path: f.path, text, el };
  content.replaceChildren(el);
  content.scrollTop = keepScroll;
}

/** Lists the memory of the selected folder; keeps the file in view when it is still there. */
async function refresh() {
  if (!st.visible) return;
  const seq = ++st.seq;
  const folders = selectionFolders();
  const os = store.get().platform.os;
  st.folder = folders.find((f) => st.pick !== null && samePath(f, st.pick, os)) ?? folders[0] ?? null;
  renderBar();
  const p = profile();
  if (!st.folder) return message("Select a folder or project in the sidebar to see the memory Claude loads there.");
  if (!p) return message("No Claude profile found.");
  const res = await call("memory_files", { profile: p.dir, folder: st.folder }, { quiet: true });
  if (seq !== st.seq) return;
  if (!res.ok) return message(res.error.message);
  st.files = res.value;
  const keep = st.files.find((f) => f.path === st.selected);
  // the most specific file that exists, which is what most often needs a look
  const first =
    st.files.find((f) => f.level === "project" && f.exists) ??
    [...st.files].reverse().find((f) => f.exists && f.level !== "auto") ??
    st.files[0];
  const next = keep ?? first;
  if (next) await select(next.path);
  else renderList();
}

function buildBody(body: HTMLElement) {
  bar = h("div", { class: "mem-bar" });
  list = h("div", { class: "mem-list", attrs: { role: "navigation", "aria-label": "Memory files" } });
  head = h("div", { class: "mem-head" });
  content = h("div", { class: "mem-content" });
  body.classList.add("mem-view");
  body.append(
    h(
      "div",
      { class: "mem-main" },
      h("div", { class: "mem-left" }, bar, list),
      h("div", { class: "mem-right" }, head, content),
    ),
  );
}

export const memoryView = {
  id: "memory" as const,
  title: "Memory",
  order: 2,
  mount: buildBody,
  onShow() {
    st.visible = true;
    void refresh();
  },
  onHide() {
    st.visible = false;
  },
};

/** Follows the sidebar selection and the profile in view; rereads when the app comes back to the front. */
export function startFollowing(): void {
  store.select(
    (s) => s.sidebarSelection,
    () => {
      st.pick = null;
      void refresh();
    },
  );
  store.select(
    (s) => s.currentProfile,
    () => {
      st.profile = null;
      void refresh();
    },
  );
  on("refresh:full", () => void refresh());
  window.addEventListener("focus", () => void refresh());
}

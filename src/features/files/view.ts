// The Files view: the folder selected in the sidebar as a tree on the left (explorer.ts), the chosen file
// read-only on the right, coloured, or as a document for markdown.

import { call } from "../../core/api";
import { on } from "../../core/bus";
import { h } from "../../core/dom";
import { size } from "../../core/format";
import { store } from "../../core/store";
import { button } from "../../ui/button";
import { segmented } from "../../ui/segmented";
import { splitter } from "../../ui/splitter";
import { renderMarkdown } from "../memory/api";
import { openInCode, reveal, revealLabel } from "../os/api";
import { createCodeView } from "./code";
import { createExplorer, type Explorer, loadPref, savePref } from "./explorer";
import { absPath, isUnder, parentRel, renamed } from "./tree";

const LEFT_MIN = 200;
const RIGHT_MIN = 240;
const SPLIT_KEY = "files.split";
const MD_KEY = "files.markdown";

type MdMode = "preview" | "source";

const st = {
  visible: false,
  mdMode: (loadPref(MD_KEY) === "source" ? "source" : "preview") as MdMode,
  /** The file in the preview. */
  file: null as string | null,
  fileSeq: 0,
};

let explorer: Explorer;
let head: HTMLElement;
let content: HTMLElement;
const code = createCodeView();

function selectionFolders(): string[] {
  const sel = store.get().sidebarSelection;
  if (!sel) return [];
  return sel.kind === "group" ? (sel.folders ?? []) : sel.path ? [sel.path] : [];
}

// ---------- the preview ----------

function closeFile() {
  st.file = null;
  st.fileSeq++;
  head.replaceChildren();
  code.clear();
  content.replaceChildren(h("div", { class: "fm-empty" }, "Select a file to see it here."));
}

function isMarkdown(rel: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(rel);
}

function renderHead(rel: string, abs: string) {
  const actions: HTMLElement[] = [];
  if (isMarkdown(rel)) {
    const mode = segmented<MdMode>({
      label: "Markdown",
      items: [
        { id: "preview", label: "Preview" },
        { id: "source", label: "Source" },
      ],
      value: st.mdMode,
      onChange: (m) => {
        st.mdMode = m;
        savePref(MD_KEY, m);
        void openFile(rel);
      },
    });
    actions.push(mode.el);
  }
  actions.push(
    button({ icon: "vscode", kind: "plain", title: "Open in VS Code", onClick: () => void openInCode([abs]) }),
    button({ icon: "folder", kind: "plain", title: revealLabel(), onClick: () => void reveal(abs) }),
  );
  const path = h("span", { class: "fm-path selectable" }, rel);
  path.dataset.tip = abs;
  head.replaceChildren(path, h("span", { class: "fm-actions" }, ...actions));
}

/** A link in a markdown file: https opens in the browser, a file of this folder opens here. */
function openLink(href: string, from: string) {
  if (/^https:\/\//i.test(href)) {
    void call("open_url_https", { url: href });
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return;
  const out: string[] = parentRel(from) ? parentRel(from).split("/") : [];
  for (const part of decodeURI(href.split("#")[0] ?? "").split("/")) {
    if (part === "..") {
      if (!out.length) return;
      out.pop();
    } else if (part && part !== ".") out.push(part);
  }
  if (out.length) void explorer.showPath(out.join("/"));
}

async function openFile(rel: string) {
  const root = explorer.root();
  if (!root) return;
  const same = st.file === rel;
  const scroll = same ? content.scrollTop : 0;
  st.file = rel;
  const seq = ++st.fileSeq;
  const abs = absPath(root, rel);
  renderHead(rel, abs);
  const res = await call("files_read", { root, path: rel }, { quiet: true });
  if (seq !== st.fileSeq) return;
  const msg = (text: string) => content.replaceChildren(h("div", { class: "fm-empty" }, text));
  if (!res.ok) return msg(res.error.message);
  const f = res.value;
  if (f.kind === "missing") return msg("This file no longer exists.");
  if (f.kind === "binary") return msg("Binary file: no preview.");
  if (f.kind === "large") return msg(`Too large to preview (${size(f.size / 1024)}). Open it in an editor.`);
  if (isMarkdown(rel) && st.mdMode === "preview") {
    code.clear();
    const doc = await renderMarkdown(f.text.trim() ? f.text : "(empty)", (href) => openLink(href, rel));
    if (seq !== st.fileSeq) return;
    content.replaceChildren(h("div", { class: "fm-doc-scroll" }, doc));
    (content.firstElementChild as HTMLElement).scrollTop = scroll;
    return;
  }
  if (content.firstElementChild !== code.el) content.replaceChildren(code.el);
  code.show(rel, f.text);
}

// ---------- layout ----------

function buildBody(body: HTMLElement) {
  head = h("div", { class: "fm-head" });
  content = h("div", { class: "fm-content" });
  explorer = createExplorer({
    noRoot: "Select a folder or project in the sidebar to see its files.",
    onSelectFile: (rel) => void openFile(rel),
    onRenamed: (from, to) => {
      if (st.file !== null && isUnder(st.file, from)) void openFile(renamed(st.file, from, to));
    },
    onTrashed: (rel) => {
      if (st.file !== null && isUnder(st.file, rel)) closeFile();
    },
  });
  const left = h("div", { class: "fm-left" }, explorer.el);
  const divider = h("div", { class: "fm-divider" });
  const main = h("div", { class: "fm-main" }, left, divider, h("div", { class: "fm-right" }, head, content));
  body.classList.add("fm-view");
  body.append(main);
  const setLeft = (px: number) => {
    left.style.width = `${px}px`;
  };
  splitter({
    el: divider,
    label: "Resize the file tree",
    get: () => left.getBoundingClientRect().width,
    min: LEFT_MIN,
    max: () => Math.max(LEFT_MIN, main.clientWidth - RIGHT_MIN),
    onResize: setLeft,
    onCommit: (px) => savePref(SPLIT_KEY, String(px)),
  });
  const saved = Number(loadPref(SPLIT_KEY));
  if (saved >= LEFT_MIN) setLeft(saved);
  closeFile();
  follow();
}

/** The tree shows the folder selected in the sidebar (a project's first folder; the bar switches). */
function follow() {
  const folders = selectionFolders();
  const root = explorer.root();
  if (root === null || !folders.includes(root)) {
    closeFile();
    explorer.setRoot(folders[0] ?? null, folders);
  } else explorer.setRoot(root, folders);
}

export const filesView = {
  id: "files" as const,
  title: "Files",
  order: 1.5,
  mount: buildBody,
  onShow() {
    st.visible = true;
    explorer.setShown(true);
  },
  onHide() {
    st.visible = false;
    explorer.setShown(false);
  },
};

/** Follows the sidebar selection; rereads the file in view when the app comes back to the front. */
export function startFollowing(): void {
  store.select((s) => s.sidebarSelection, follow);
  on("refresh:full", () => void explorer.refresh());
  window.addEventListener("focus", () => {
    if (st.visible && st.file !== null) void openFile(st.file);
  });
}

// Markdown rendered as a document (headings, lists, task boxes, quotes, code, tables, links) from the Lezer
// Markdown parser's tree (with GitHub's tables, task lists and strikethrough), which loads the first time a
// memory file is shown. Every piece of the file goes in as text: raw HTML in it shows as code, never runs.

import type { SyntaxNode } from "@lezer/common";
import { h } from "../../core/dom";

/** Called for a clicked link with its target as written. */
export type OnLink = (href: string) => void;

/** Marks the document shows by layout instead (`#`, `*`, `>`, backticks, link brackets, table bars). */
const MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "CodeInfo",
  "LinkMark",
  "QuoteMark",
  "ListMark",
  "StrikethroughMark",
  "TableDelimiter",
  "LinkTitle",
  "LinkLabel",
]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function entity(raw: string): string {
  const name = raw.slice(1, -1);
  if (name.startsWith("#x") || name.startsWith("#X"))
    return String.fromCodePoint(Number.parseInt(name.slice(2), 16) || 63);
  if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)) || 63);
  return ENTITIES[name] ?? raw;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

export async function renderMarkdown(text: string, onLink: OnLink): Promise<HTMLElement> {
  const doc = h("div", { class: "mem-doc selectable" });
  let tree: SyntaxNode;
  try {
    const { parser, GFM } = await import("@lezer/markdown");
    tree = parser.configure(GFM).parse(text).topNode;
  } catch {
    doc.append(h("pre", {}, text));
    return doc;
  }
  const src = (n: SyntaxNode) => text.slice(n.from, n.to);

  /** A node's inline content: the text between its children, and each child rendered. */
  function inline(node: SyntaxNode, into: HTMLElement, from = node.from, to = node.to) {
    let pos = from;
    for (const c of children(node)) {
      if (c.to <= from || c.from >= to) continue;
      // soft line breaks inside a paragraph read as spaces
      if (c.from > pos) into.append(text.slice(pos, c.from));
      const el = inlineNode(c);
      if (el) into.append(el);
      pos = c.to;
    }
    if (to > pos) into.append(text.slice(pos, to));
  }

  function inlineNode(n: SyntaxNode): Node | string | null {
    if (MARKS.has(n.name)) return null;
    switch (n.name) {
      case "Emphasis":
        return wrap("em", n);
      case "StrongEmphasis":
        return wrap("strong", n);
      case "Strikethrough":
        return wrap("s", n);
      case "InlineCode": {
        const marks = children(n).filter((c) => c.name === "CodeMark");
        const from = marks[0]?.to ?? n.from;
        const to = marks[1]?.from ?? n.to;
        return h("code", {}, text.slice(from, to));
      }
      case "Link":
      case "Image":
      case "Autolink": {
        const url = children(n).find((c) => c.name === "URL");
        const href = url ? src(url) : "";
        const a = h("a", {
          href: "#",
          title: href,
          onclick: (e: MouseEvent) => {
            e.preventDefault();
            if (href) onLink(href);
          },
        });
        if (n.name === "Autolink") a.append(href);
        else {
          // the text is between the first [ and its ]
          const marks = children(n).filter((c) => c.name === "LinkMark");
          inline(n, a, marks[0]?.to ?? n.from, marks[1]?.from ?? n.to);
        }
        return a;
      }
      case "URL":
        return src(n);
      case "Escape":
        return src(n).slice(1);
      case "Entity":
        return entity(src(n));
      case "HardBreak":
        return h("br");
      case "HTMLTag":
      case "Comment":
        return h("code", {}, src(n));
      case "Task":
        return task(n);
      default:
        return src(n);
    }
  }

  function wrap(tag: "em" | "strong" | "s", n: SyntaxNode): HTMLElement {
    const el = h(tag);
    inline(n, el);
    return el;
  }

  function task(n: SyntaxNode): HTMLElement {
    const marker = children(n).find((c) => c.name === "TaskMarker");
    const done = marker ? /x/i.test(src(marker)) : false;
    const el = h("span", { class: "mem-task" }, h("input", { type: "checkbox", checked: done, disabled: true }));
    // the text starts after the box and the space following it
    let from = marker?.to ?? n.from;
    while (text[from] === " ") from++;
    inline(n, el, from);
    return el;
  }

  function block(n: SyntaxNode, into: HTMLElement) {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(n.name);
    if (heading) {
      const el = h(`h${heading[1]}` as "h1");
      inline(n, el);
      // the text after "# " starts with the space: trim it
      el.normalize();
      if (el.firstChild?.nodeType === Node.TEXT_NODE)
        el.firstChild.textContent = el.firstChild.textContent?.trimStart() ?? "";
      into.append(el);
      return;
    }
    switch (n.name) {
      case "Paragraph": {
        const el = h("p");
        inline(n, el);
        into.append(el);
        return;
      }
      case "BulletList":
      case "OrderedList": {
        const el = h(n.name === "BulletList" ? "ul" : "ol");
        const first = children(n)[0];
        const start = first ? Number.parseInt(src(children(first)[0] ?? first), 10) : 1;
        if (n.name === "OrderedList" && start > 1) el.setAttribute("start", String(start));
        for (const item of children(n)) {
          const li = h("li");
          for (const c of children(item)) {
            if (c.name === "ListMark") continue;
            if (c.name === "Task") {
              li.classList.add("mem-task-item");
              li.append(task(c));
            } else block(c, li);
          }
          el.append(li);
        }
        into.append(el);
        return;
      }
      case "Blockquote": {
        const el = h("blockquote");
        for (const c of children(n)) if (c.name !== "QuoteMark") block(c, el);
        into.append(el);
        return;
      }
      case "FencedCode":
      case "CodeBlock": {
        const code = children(n).find((c) => c.name === "CodeText");
        into.append(h("pre", {}, h("code", {}, code ? src(code) : "")));
        return;
      }
      case "HorizontalRule":
        into.append(h("hr"));
        return;
      case "Table": {
        const table = h("table");
        for (const row of children(n)) {
          if (row.name !== "TableHeader" && row.name !== "TableRow") continue;
          const tr = h("tr");
          for (const cell of children(row)) {
            if (cell.name !== "TableCell") continue;
            const td = h(row.name === "TableHeader" ? "th" : "td");
            inline(cell, td);
            tr.append(td);
          }
          table.append(tr);
        }
        into.append(h("div", { class: "mem-table" }, table));
        return;
      }
      case "HTMLBlock":
      case "CommentBlock":
      case "ProcessingInstructionBlock":
        into.append(h("pre", {}, h("code", {}, src(n))));
        return;
      case "LinkReference":
        return;
      default: {
        const el = h("p");
        inline(n, el);
        into.append(el);
      }
    }
  }

  for (const n of children(tree)) block(n, doc);
  return doc;
}

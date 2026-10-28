// Commit history across local and remote branches and tags, laid out like VS Code's graph: compact rows,
// each row's lanes only as wide as it needs, then the subject (bold for the checked-out commit), the
// author and branch / tag pills (the checked-out branch accent-tinted). Resting the pointer on a row
// shows the commit's card (card.ts) with its time, message and stats.

import { h } from "../../core/dom";
import { createList } from "../../ui/list";
import { createCommitCard } from "./card";
import { type GraphRow, graphSvg, graphWidth, layoutGraph, MAX_DRAWN_LANES, ROW_HEIGHT } from "./graph";

const rowWidth = (g: GraphRow) => graphWidth(Math.min(MAX_DRAWN_LANES, g.lanes));

import { type Commit, isHead, refPills } from "./strings";

interface HistoryRow {
  commit: Commit;
  graph: GraphRow;
  pills: string[];
}

export interface History {
  el: HTMLElement;
  set(commits: Commit[]): void;
  selected(): string | null;
  clearSelection(): void;
}

/** `repo`: the repository in view (the card reads the commit's details from it). */
export function createHistory(onSelect: (hash: string | null) => void, repo: () => string | null): History {
  const card = createCommitCard(repo);
  const byHash = new Map<string, Commit>();
  const graphs = new WeakMap<HTMLElement, GraphRow>();
  const list = createList<HistoryRow>({
    label: "History",
    key: (r) => r.commit.hash,
    height: () => ROW_HEIGHT,
    create: () =>
      h(
        "div",
        { class: "git-commit" },
        h("span", { class: "git-graph-cell" }),
        h("span", { class: "git-subject" }),
        h("span", { class: "git-author" }),
        h("span", { class: "git-pills" }),
      ),
    update(el, row) {
      const [cell, subject, author, pills] = [...el.children] as HTMLElement[];
      if (!cell || !subject || !author || !pills) return;
      if (graphs.get(el) !== row.graph) {
        // numbers and fixed names only (see graphSvg)
        cell.innerHTML = graphSvg(row.graph, rowWidth(row.graph));
        graphs.set(el, row.graph);
      }
      subject.textContent = row.commit.subject;
      subject.classList.toggle("head", row.graph.head);
      author.textContent = row.commit.author;
      if (pills.dataset.refs !== row.commit.refs) {
        pills.dataset.refs = row.commit.refs;
        // row-reverse: the last pill sits at the right; pills that do not fit wrap out of sight
        pills.replaceChildren(
          ...[...row.pills].reverse().map((p) => {
            const head = p.startsWith("*");
            return h("span", { class: `git-pill${head ? " git-pill-head" : ""}` }, head ? p.slice(1) : p);
          }),
        );
      }
    },
    onSelectionChange: (keys) => onSelect(keys[0] ?? null),
  });
  list.el.classList.add("git-history");
  // the card follows the row under the pointer (rows are reused, so look the commit up by the row's key)
  const rowAt = (t: EventTarget | null) =>
    t instanceof Element ? t.closest<HTMLElement>(".git-history .list-row") : null;
  list.el.addEventListener("pointerover", (e) => {
    const row = rowAt(e.target);
    const commit = row ? byHash.get(row.dataset.key ?? "") : undefined;
    if (row && commit) card.hover(row, commit);
  });
  list.el.addEventListener("pointerout", (e) => {
    const from = rowAt(e.target);
    if (from && from !== rowAt(e.relatedTarget)) card.leave();
  });
  list.el.addEventListener("scroll", () => card.hide(), { passive: true });

  return {
    el: list.el,
    set(commits) {
      byHash.clear();
      for (const c of commits) byHash.set(c.hash, c);
      const g = layoutGraph(
        commits.map((c) => c.hash),
        commits.map((c) => c.parents),
        commits.map((c) => isHead(c.refs)),
      );
      list.setRows(
        commits.map((commit, i) => ({ commit, graph: g.rows[i] as GraphRow, pills: refPills(commit.refs) })),
      );
    },
    selected: () => list.selection.selected[0] ?? null,
    clearSelection() {
      list.selection.clear();
      list.refresh();
    },
  };
}

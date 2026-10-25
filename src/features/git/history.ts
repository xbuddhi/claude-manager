// Commit history across local and remote branches and tags: graph lanes, subject, branch / tag pills
// (the checked-out branch accent-tinted) and a short age.

import { h } from "../../core/dom";
import { createList } from "../../ui/list";
import { type GraphRow, graphSvg, graphWidth, layoutGraph, MAX_DRAWN_LANES, ROW_HEIGHT } from "./graph";
import { type Commit, isHead, refPills, shortAge } from "./strings";

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

export function createHistory(onSelect: (hash: string | null) => void): History {
  let width = graphWidth(1);
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
        h("span", { class: "git-pills" }),
        h("span", { class: "git-age" }),
      ),
    update(el, row) {
      const [cell, subject, pills, age] = [...el.children] as HTMLElement[];
      if (!cell || !subject || !pills || !age) return;
      if (graphs.get(el) !== row.graph || cell.dataset.w !== String(width)) {
        // numbers and fixed names only (see graphSvg)
        cell.innerHTML = graphSvg(row.graph, width);
        cell.dataset.w = String(width);
        graphs.set(el, row.graph);
      }
      subject.textContent = row.commit.subject;
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
      age.textContent = shortAge(row.commit.at);
      el.dataset.tip = `${row.commit.subject}\n${row.commit.author} · ${row.commit.hash.slice(0, 7)}`;
    },
    onSelectionChange: (keys) => onSelect(keys[0] ?? null),
  });
  list.el.classList.add("git-history");

  return {
    el: list.el,
    set(commits) {
      const g = layoutGraph(
        commits.map((c) => c.hash),
        commits.map((c) => c.parents),
        commits.map((c) => isHead(c.refs)),
      );
      width = graphWidth(Math.min(MAX_DRAWN_LANES, g.maxLanes));
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

// The Pull requests list: the repository's open pull requests from GitHub (number, title, author, branch,
// age, a Draft mark). A click (or Enter) opens one in the browser. Without the GitHub CLI, signed out, or
// on an error, it says why and offers the repository's pull request page instead.

import type { PullRequest } from "../../bindings/PullRequest";
import type { PullRequests } from "../../bindings/PullRequests";
import { h } from "../../core/dom";
import { ago } from "../../core/format";
import { button } from "../../ui/button";
import { createList } from "../../ui/list";
import { openUrlHttps } from "../os/api";
import { TEXT } from "./strings";

export interface Pulls {
  el: HTMLElement;
  /** null: loading. `web`: the repository's page, for the "Open pull requests on GitHub" link. */
  set(result: PullRequests | null, web: string | null): void;
}

export function createPulls(): Pulls {
  const open = (p: PullRequest) => void openUrlHttps(p.url);
  const list = createList<PullRequest>({
    label: "Pull requests",
    key: (p) => String(p.number),
    height: () => 44,
    create: () =>
      h(
        "div",
        { class: "git-row git-two git-pr" },
        h(
          "span",
          { class: "git-two-text" },
          h(
            "span",
            { class: "git-two-title" },
            h("span", { class: "git-pr-num" }),
            h("span", { class: "git-pr-title" }),
            h("span", { class: "git-pr-draft" }, "Draft"),
          ),
          h("span", { class: "git-two-meta" }),
        ),
      ),
    update(el, p) {
      const num = el.querySelector<HTMLElement>(".git-pr-num");
      const title = el.querySelector<HTMLElement>(".git-pr-title");
      const draft = el.querySelector<HTMLElement>(".git-pr-draft");
      const meta = el.querySelector<HTMLElement>(".git-two-meta");
      if (!num || !title || !draft || !meta) return;
      num.textContent = `#${p.number}`;
      title.textContent = p.title;
      draft.hidden = !p.draft;
      meta.textContent = [p.author, p.branch, ago(Date.parse(p.updated))].filter(Boolean).join("  ·  ");
      el.dataset.tip = `#${p.number} ${p.title}\nOpen on GitHub`;
    },
    onActivate: open,
  });
  // one click opens it (the row is a link to its page, not a selection)
  list.el.addEventListener("click", (e) => {
    const key = (e.target as Element | null)?.closest<HTMLElement>(".list-row")?.dataset.key;
    const p = list.rowByKey(key ?? "");
    if (p) open(p);
  });
  const note = h("div", { class: "git-empty git-pr-note" });
  let web: string | null = null;
  const link = button({
    label: TEXT.openPulls,
    icon: "external",
    kind: "secondary",
    onClick: () => web && void openUrlHttps(`${web}/pulls`),
  });
  const foot = h("div", { class: "git-pr-foot" }, link);
  const el = h("div", { class: "git-changes git-pulls" }, list.el, note, foot);
  return {
    el,
    set(result, url) {
      web = url;
      foot.hidden = !url;
      const prs = result?.kind === "list" ? result.prs : [];
      list.setRows(prs);
      const text =
        result === null
          ? TEXT.pullsLoading
          : result.kind === "noGh"
            ? TEXT.noGh
            : result.kind === "signedOut"
              ? TEXT.ghSignedOut
              : result.kind === "failed"
                ? result.message
                : prs.length
                  ? ""
                  : TEXT.noPulls;
      note.textContent = text;
      note.hidden = !text;
    },
  };
}

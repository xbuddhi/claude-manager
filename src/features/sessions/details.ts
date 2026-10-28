// The details pane under the table (as tall as its prompt, at most 3 lines): the selected session's full prompt and its meta line, or a hint
// for what is selected in the sidebar; Resume / Switch to, Fork and Delete on the right.

import type { Session } from "../../bindings/Session";
import { h } from "../../core/dom";
import { iconNode } from "../../core/icons";
import { isMac } from "../../core/platform";
import { button } from "../../ui/button";
import { setTip } from "../../ui/tooltip";
import { playIcon } from "./icons";
import type { Scope } from "./model";
import {
  deleteLabel,
  deleteTip,
  detailMeta,
  detailText,
  groupHint,
  HINT_DEFAULT,
  HINT_NO_SESSIONS,
  resumeTip,
  TIP_FORK,
} from "./strings";

/**
 * Text and meta line for the pane. `level` is the first selected session's live level; `hint` replaces the
 * default hint (e.g. while the index loads).
 */
export function detailsFor(
  scope: Scope | null,
  selected: readonly Session[],
  level: number,
  profileName: (dir: string) => string,
  hint = HINT_DEFAULT,
): { text: string; meta: string } {
  const s = selected[0];
  if (s) return { text: detailText(s.full, level), meta: detailMeta(s, profileName(s.profile)) };
  if (scope?.kind === "folder" && scope.sessions.length === 0) return { text: HINT_NO_SESSIONS, meta: scope.path };
  if (scope?.kind === "group")
    return { text: groupHint(scope.name, scope.folders.length), meta: scope.folders.join("     ") };
  return { text: hint, meta: scope?.kind === "folder" ? scope.path : "" };
}

export interface DetailsOptions {
  onResume(): void;
  onFork(): void;
  onDelete(): void;
}

export interface Details {
  el: HTMLElement;
  render(
    scope: Scope | null,
    selected: readonly Session[],
    level: number,
    profileName: (dir: string) => string,
    hint?: string,
  ): void;
}

export function createDetails(opts: DetailsOptions): Details {
  const text = h("p", { class: "ses-dtext selectable" });
  const meta = h("div", { class: "ses-dmeta selectable" });
  const resume = button({
    label: "Resume",
    icon: playIcon(),
    kind: "primary",
    title: resumeTip(isMac()),
    onClick: opts.onResume,
  });
  const fork = button({ label: "Fork", icon: "fork", kind: "secondary", title: TIP_FORK, onClick: opts.onFork });
  const del = button({ icon: "trash", kind: "danger", title: deleteTip(1, isMac()), onClick: opts.onDelete });
  const actions = h("div", { class: "ses-dactions" }, resume, fork, del);
  const el = h("div", { class: "ses-details" }, h("div", { class: "ses-dbody" }, text, meta), actions);

  return {
    el,
    render(scope, selected, level, profileName, hint) {
      const content = detailsFor(scope, selected, level, profileName, hint);
      text.textContent = content.text;
      meta.textContent = content.meta;
      const n = selected.length;
      el.classList.toggle("hint", n === 0);
      actions.hidden = n === 0;
      resume.hidden = fork.hidden = n !== 1;
      const resumeText = level ? "Switch to" : "Resume";
      const label = resume.querySelector(".btn-label");
      if (label && label.textContent !== resumeText) label.textContent = resumeText;
      // an icon alone for one session, "Delete N" for several
      const delText = deleteLabel(n);
      if ((del.querySelector(".btn-label")?.textContent ?? "") !== delText) {
        del.replaceChildren(iconNode("trash"), ...(delText ? [h("span", { class: "btn-label" }, delText)] : []));
        del.classList.toggle("btn-icon", !delText);
        if (delText) del.removeAttribute("aria-label");
        else del.setAttribute("aria-label", "Delete");
      }
      setTip(del, deleteTip(n, isMac()));
    },
  };
}

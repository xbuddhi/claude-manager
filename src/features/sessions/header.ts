// The sessions view's part of the card head: the archived toggle, the New Session split button and the Open
// menu (the session count is a badge in the table's Session column). Shown only while the Sessions view is
// (the views registry hides it otherwise).

import { iconNode } from "../../core/icons";
import { store } from "../../core/store";
import { button, setButtonLabel } from "../../ui/button";
import { showMenu } from "../../ui/menu";
import { splitButton } from "../../ui/splitbutton";
import { repoWebUrl } from "../git/api";
import { doNew } from "./actions";
import { archiveIcon } from "./icons";
import { newSessionMenuItems, openMenuItems, openTarget } from "./menus";
import { archivedText, TIP_ARCHIVED, TIP_ARCHIVED_BACK, TIP_NEW } from "./strings";

export interface Header {
  /** The New Session button, as the anchor for the folder picker. */
  newAnchor(): HTMLElement;
}

export function mountHeader(el: HTMLElement): Header {
  const newBtn = splitButton({
    label: "New Session",
    icon: "plus",
    kind: "primary",
    title: TIP_NEW,
    arrowTitle: "More ways to start a session",
    onMain: () => doNew(undefined, { anchor: newBtn.el }),
    onArrow: (anchor) => void showMenu(newSessionMenuItems(anchor), { at: { anchor }, label: "New Session" }),
  });
  const openBtn = button({
    label: "Open",
    icon: "external",
    kind: "secondary",
    onClick: async () => {
      // the repository's page is looked up as the menu opens (a quick local git call)
      const path = openTarget().path;
      const web = path ? await repoWebUrl(path) : null;
      void showMenu(openMenuItems(web), { at: { anchor: openBtn }, label: "Open" });
    },
  });
  openBtn.setAttribute("aria-haspopup", "menu");
  openBtn.append(iconNode("chevronDown"));
  openBtn.classList.add("ses-open");
  // the archive icon with the count in a badge; the words are in its tooltip and accessible name
  const archBtn = button({
    label: "0",
    icon: archiveIcon(),
    kind: "plain",
    onClick: () => store.set({ sessionsShowArchived: !store.get().sessionsShowArchived }),
  });
  archBtn.classList.add("ses-arch");
  el.append(archBtn, newBtn.el, openBtn);

  store.select(
    (s) => s.sessionsScope,
    (scope) => {
      archBtn.hidden = !scope?.archived;
      const n = scope?.archived ?? 0;
      setButtonLabel(archBtn, String(n));
      archBtn.setAttribute("aria-label", archivedText(n));
      archBtn.setAttribute("aria-pressed", String(!!scope?.showingArchived));
      archBtn.dataset.tip = `${scope?.showingArchived ? TIP_ARCHIVED_BACK : TIP_ARCHIVED} (${n})`;
      newBtn.setDisabled(!scope);
      openBtn.disabled = !scope;
    },
    { immediate: true },
  );
  return { newAnchor: () => newBtn.el };
}

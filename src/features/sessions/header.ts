// The sessions view's part of the card head: the muted count ("12   in   app"), the New Session split
// button and the Open menu. Shown only while the Sessions view is (the views registry hides it otherwise).

import { h } from "../../core/dom";
import { iconNode } from "../../core/icons";
import { store } from "../../core/store";
import { button } from "../../ui/button";
import { showMenu } from "../../ui/menu";
import { splitButton } from "../../ui/splitbutton";
import { doNew } from "./actions";
import { newSessionMenuItems, openMenuItems } from "./menus";
import { countText, TIP_NEW } from "./strings";

export interface Header {
  /** The New Session button, as the anchor for the folder picker. */
  newAnchor(): HTMLElement;
}

export function mountHeader(el: HTMLElement): Header {
  const count = h("span", { class: "ses-count", attrs: { "aria-live": "polite" } });
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
    onClick: () => void showMenu(openMenuItems(), { at: { anchor: openBtn }, label: "Open" }),
  });
  openBtn.setAttribute("aria-haspopup", "menu");
  openBtn.append(iconNode("chevronDown"));
  openBtn.classList.add("ses-open");
  el.append(count, newBtn.el, openBtn);

  store.select(
    (s) => s.sessionsScope,
    (scope) => {
      count.textContent = scope ? countText(scope.sessions.length, scope.name) : "";
      newBtn.setDisabled(!scope);
      openBtn.disabled = !scope;
    },
    { immediate: true },
  );
  return { newAnchor: () => newBtn.el };
}

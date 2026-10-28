// The companion chooser: a panel under a profile's picture with every companion, big and moving, and
// their names (what each one does is in its tooltip). The current one is marked; clicking another one makes it the profile's companion.

import { h } from "../../core/dom";
import { openPopover } from "../../ui/popover";
import { setCompanion } from "./api";
import { COMPANIONS, companionFor, companionSvg } from "./companions";
import { T } from "./strings";

/** As big as the profile's picture on its card. */
const SIZE = 84;

export function chooseCompanion(dir: string, anchor: HTMLElement, profile: string): void {
  const current = companionFor(dir).key;
  const grid = h("div", { class: "prof-pick-grid", attrs: { role: "listbox", "aria-label": T.companion } });
  let first: HTMLElement | null = null;
  for (const c of COMPANIONS) {
    const pic = h("span", { class: "prof-pick-pic" });
    // numbers and fixed names only (companions.ts)
    pic.innerHTML = companionSvg(c, SIZE, true);
    const on = c.key === current;
    const btn = h(
      "button",
      {
        type: "button",
        class: `prof-pick${on ? " on" : ""}`,
        attrs: { role: "option", "aria-selected": String(on) },
      },
      pic,
      h("span", { class: "prof-pick-name" }, c.name),
    );
    btn.dataset.tip = `${c.name} ${c.habit}`;
    btn.addEventListener("click", () => {
      void setCompanion(dir, c.key);
      pop.close();
    });
    if (on || !first) first = btn;
    grid.append(btn);
  }
  const content = h(
    "div",
    { class: "prof-chooser" },
    h("div", { class: "prof-chooser-title" }, T.chooseFor(profile)),
    grid,
  );
  const pop = openPopover({ anchor, content, align: "center", label: T.chooseFor(profile) });
  first?.focus({ preventScroll: true });
}

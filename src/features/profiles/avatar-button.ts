// The profile chip at the left of the title bar: avatar, profile name and a chevron. Its tooltip names the
// profile in view ("<name>  -  <email>"); a click opens the profile popover. A <button>, so the drag region
// lets it be clicked.

import { h } from "../../core/dom";
import { icons } from "../../core/icons";
import { animate, Spring } from "../../core/motion";
import { store } from "../../core/store";
import { profileAvatar, profileEmail, profileLabel } from "./api";
import { toggleProfilePopover } from "./popover";

/** The avatar tooltip, as the Windows app wrote it (two spaces around the dash). */
export function avatarTip(dir: string | null): string {
  return `${profileLabel(dir)}  -  ${profileEmail(dir)}`;
}

export function mountAvatarButton(slot: HTMLElement): void {
  const btn = h("button", {
    type: "button",
    class: "prof-avatar-btn",
    attrs: { "aria-haspopup": "menu", "aria-expanded": "false" },
  });
  const pic = h("span", { class: "prof-chip-pic" });
  const name = h("span", { class: "prof-chip-name" });
  const chev = h("span", { class: "prof-chip-chev" });
  chev.innerHTML = icons.chevronDown;
  btn.append(pic, name, chev);
  // press: the chip dips and springs back with the tab strip's spring (pointer events, not :active, which the
  // title bar's drag handler suppresses)
  const press = new Spring(0.3, 0.86, 0.001, 1);
  const scale = (v: number) => {
    btn.style.transform = v === 1 ? "" : `scale(${v})`;
  };
  const release = () => animate(press, 1, scale);
  btn.addEventListener("pointerdown", (e) => {
    if (e.button === 0) animate(press, 0.95, scale);
  });
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointerleave", release);
  btn.addEventListener("pointercancel", release);
  // detail 0 = Enter or Space, so the popover takes the keyboard
  btn.addEventListener("click", (e) => void toggleProfilePopover(btn, e.detail === 0));
  slot.append(btn);

  store.select(
    (s) => [s.currentProfile, s.profiles] as const,
    ([dir]) => {
      const tip = avatarTip(dir);
      pic.replaceChildren(profileAvatar(dir, 22));
      name.textContent = profileLabel(dir);
      btn.dataset.tip = tip;
      btn.setAttribute("aria-label", `Profile: ${tip}`);
    },
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1], immediate: true },
  );
}

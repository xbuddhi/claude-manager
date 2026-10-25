// The profile picture at the right end of the title bar (34px). Its tooltip names the profile in view
// ("<name>  -  <email>"); a click opens the profile popover. A <button>, so the drag region lets it be clicked.

import { h } from "../../core/dom";
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
  // detail 0 = Enter or Space, so the popover takes the keyboard
  btn.addEventListener("click", (e) => void toggleProfilePopover(btn, e.detail === 0));
  slot.append(btn);

  store.select(
    (s) => [s.currentProfile, s.profiles] as const,
    ([dir]) => {
      const tip = avatarTip(dir);
      btn.replaceChildren(profileAvatar(dir, 34));
      btn.dataset.tip = tip;
      btn.setAttribute("aria-label", `Profile: ${tip}`);
    },
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1], immediate: true },
  );
}

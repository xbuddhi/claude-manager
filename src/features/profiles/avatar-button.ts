// The profile chip at the left of the title bar: avatar, profile name and a chevron. Its tooltip names the
// profile in view ("<name>  -  <email>"); a click opens the profile popover. A <button>, so the drag region
// lets it be clicked.

import { h } from "../../core/dom";
import { icons } from "../../core/icons";
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
  const release = () => btn.classList.remove("pressed");
  btn.addEventListener("pointerdown", (e) => {
    if (e.button === 0) btn.classList.add("pressed");
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, release);
  // detail 0 = Enter or Space, so the popover takes the keyboard
  btn.addEventListener("click", (e) => void toggleProfilePopover(btn, e.detail === 0));
  slot.append(btn);

  store.select(
    (s) => [s.currentProfile, s.profiles, s.settings.profileCompanions] as const,
    ([dir]) => {
      const tip = avatarTip(dir);
      pic.replaceChildren(profileAvatar(dir, 22));
      name.textContent = profileLabel(dir);
      btn.dataset.tip = tip;
      btn.setAttribute("aria-label", `Profile: ${tip}`);
    },
    { equals: (a, b) => a.every((v, i) => v === b[i]), immediate: true },
  );
}

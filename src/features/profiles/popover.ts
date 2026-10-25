// The profile popover under the avatar (Chrome style, ClaudeManager.ps1 avatar click + MacUI ProfilePopup):
// the profile in view, the others to switch to, add / manage / open folder / settings, the notifications
// switch, and on Windows the Explorer menu, then refresh and closing background sessions. Picking a row
// closes it; the switch flips in place.

import { call } from "../../core/api";
import { emit } from "../../core/bus";
import { hasCommand, runCommand } from "../../core/commands";
import { h } from "../../core/dom";
import { type IconSpec, iconNode } from "../../core/icons";
import { isMac, isWindows, shortcutLabel } from "../../core/platform";
import { settings } from "../../core/settings";
import { store } from "../../core/store";
import { openPopover, type Popover } from "../../ui/popover";
import { toast } from "../../ui/toast";
import { toggle } from "../../ui/toggle";
import { explorerMenuInstall, explorerMenuRemove, explorerMenuState } from "../os/api";
import { profileAvatar, profileEmail, profileLabel, setNotifications } from "./api";
import { enterProfile } from "./startup";
import { T } from "./strings";

/** Command of the live feature (WP3) that ends claude processes no window belongs to. */
const CLOSE_ORPHANS = ["live:closeOrphans", "live.closeOrphans"];

const PEOPLE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="5.5" r="2.3"/>
  <path d="M1.8 13.5c.4-2.4 2.1-3.8 4.2-3.8s3.8 1.4 4.2 3.8M10.5 3.4a2.2 2.2 0 0 1 0 4.2M12 9.9c1.2.5 2 1.7 2.2 3.6"/></svg>`;

function people(): Element {
  const t = document.createElement("template");
  t.innerHTML = PEOPLE_ICON;
  return t.content.firstElementChild as Element;
}

let open: Popover | null = null;

function sep() {
  return h("div", { class: "prof-pop-sep", attrs: { role: "separator" } });
}

function profileRow(dir: string | null, pick: (run: () => void) => void): HTMLElement {
  const name = profileLabel(dir);
  return h(
    "button",
    {
      type: "button",
      class: "prof-pop-row prof-pop-profile",
      attrs: { role: "menuitem" },
      onclick: () => pick(() => enterProfile(dir)),
    },
    profileAvatar(dir, 32),
    h(
      "span",
      { class: "prof-pop-text" },
      h("span", {}, name),
      h("span", { class: "prof-pop-mail" }, profileEmail(dir)),
    ),
  );
}

function actionRow(icon: IconSpec, label: string, run: () => void, side?: string): HTMLElement {
  return h(
    "button",
    { type: "button", class: "prof-pop-row", attrs: { role: "menuitem" }, onclick: run },
    h("span", { class: "prof-pop-icon" }, iconNode(icon)),
    h("span", { class: "prof-pop-label" }, label),
    side ? h("span", { class: "prof-pop-side" }, side) : null,
  );
}

function closeOrphans() {
  const id = CLOSE_ORPHANS.find(hasCommand);
  if (id) runCommand(id);
  else toast(T.notAvailable("Closing background sessions"));
}

async function build(pick: (run: () => void) => void): Promise<HTMLElement> {
  const s = store.get();
  const cur = s.currentProfile;
  const others: Array<string | null> = s.profiles.map((p) => p.dir).filter((d) => d !== cur);
  if (cur !== null) others.push(null);
  const explorer = isWindows() ? await explorerMenuState() : null;

  const header = h(
    "div",
    { class: "prof-pop-head" },
    profileAvatar(cur, 64),
    h("span", { class: "prof-pop-name" }, profileLabel(cur)),
    h("span", { class: "prof-pop-mail" }, profileEmail(cur)),
  );
  const notify = toggle({
    checked: settings().notify,
    label: T.notifications,
    onChange: (on) => void setNotifications(on),
  });
  const notifyRow = h(
    "div",
    { class: "prof-pop-row prof-pop-toggle" },
    h("span", { class: "prof-pop-icon" }, iconNode("bell")),
    h("span", { class: "prof-pop-label" }, T.notifications),
    notify.el,
  );
  // the whole row flips the switch, without closing
  notifyRow.addEventListener("click", (e) => {
    if (!notify.el.contains(e.target as Node)) notify.el.click();
  });

  const folderLabel = isMac() ? T.openFolderMac : T.openFolder;
  const refreshKeys = shortcutLabel(isMac() ? "Cmd+R" : "F5");
  return h(
    "div",
    { class: "prof-pop", attrs: { role: "menu", "aria-label": "Profile" } },
    header,
    others.length ? sep() : null,
    others.length ? h("div", { class: "prof-pop-label-row" }, T.switchTo) : null,
    ...others.map((d) => profileRow(d, pick)),
    sep(),
    actionRow("plus", T.addProfile, () => pick(() => emit("profile:new"))),
    actionRow(people(), T.manageProfiles, () => pick(() => emit("picker:show"))),
    cur !== null
      ? actionRow("folder", folderLabel, () => pick(() => void call("open_profile_folder", { dir: cur })))
      : null,
    actionRow("gear", T.settings, () => pick(() => runCommand("app:settings"))),
    sep(),
    notifyRow,
    sep(),
    explorer === null
      ? null
      : actionRow("external", explorer ? T.explorerRemove : T.explorerAdd, () =>
          pick(() => void (explorer ? explorerMenuRemove() : explorerMenuInstall())),
        ),
    actionRow("refresh", T.refreshAll, () => pick(() => runCommand("refresh:full")), refreshKeys),
    actionRow("trash", T.closeOrphans, () => pick(closeOrphans)),
  );
}

/** Up/Down (and Home/End) move between the rows and the switch. */
function onKey(content: HTMLElement, e: KeyboardEvent) {
  const items = [...content.querySelectorAll<HTMLElement>("button")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const n = items.length;
  const next =
    e.key === "ArrowDown"
      ? (i + 1) % n
      : e.key === "ArrowUp"
        ? (i - 1 + n) % n
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? n - 1
            : -1;
  if (next < 0 || !n) return;
  e.preventDefault();
  items[next]?.focus();
}

/** Opens the popover under `anchor`, or closes it when it is open. */
export async function toggleProfilePopover(anchor: HTMLElement, byKeyboard: boolean): Promise<void> {
  if (open) {
    open.close();
    return;
  }
  const pick = (run: () => void) => {
    open?.close();
    run();
  };
  const content = await build(pick);
  if (open) return; // opened meanwhile by a second click
  content.addEventListener("keydown", (e) => onKey(content, e));
  const pop = openPopover({
    anchor,
    content,
    label: "Profile",
    onClose: () => {
      if (open === pop) open = null;
      anchor.setAttribute("aria-expanded", "false");
    },
  });
  open = pop;
  anchor.setAttribute("aria-expanded", "true");
  if (byKeyboard) content.querySelector<HTMLElement>("button")?.focus();
}

export function closeProfilePopover(): void {
  open?.close();
}

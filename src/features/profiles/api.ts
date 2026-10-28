// Public API of the profiles feature (WP6). Other features may import this file only.
// These follow the spec ("Profile discovery, names, colors, email" and the start-profile rule).

import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { describeError, log } from "../../core/log";
import { samePath } from "../../core/paths";
import { isMac } from "../../core/platform";
import { profileName, profiles } from "../../core/profiles";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { avatar } from "../../ui/avatar";
import { input } from "../../ui/dialog";
import { toast } from "../../ui/toast";
import { T } from "./strings";

/** Avatar colours, picked by the sum of the name's UTF-16 code units (as the Windows app). White ink. */
const COLORS = ["#0A84FF", "#BF5AF2", "#FF375F", "#FF9F0A", "#30D158", "#5E5CE6", "#64D2FF", "#FF453A"];

/** Avatar colour for a profile name; null = "All profiles", which uses the control colour. */
export function profileColor(name: string | null): string {
  if (name === null) return "var(--ctrl)";
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return COLORS[sum % COLORS.length] ?? "var(--ctrl)";
}

/** Avatar letter(s): the name's first character upper-cased; "All" for all profiles. */
export function profileInitial(name: string | null): string {
  if (name === null) return "All";
  return (name[0] ?? "?").toUpperCase();
}

/** Display name of a profile folder; null = "All profiles". */
export function profileLabel(dir: string | null): string {
  return dir === null ? "All profiles" : profileName(dir);
}

/**
 * Asks for a new name for the profile `dir`. Only the app's name changes (settings.profileNames); the
 * folder and Claude Code's own settings stay as they are. An empty name brings back the folder's name.
 */
export async function renameProfile(dir: string): Promise<void> {
  const typed = await input(T.renamePrompt, { value: profileName(dir) });
  if (typed === null) return;
  const name = typed.trim();
  const names = { ...settings().profileNames };
  if (name) names[dir] = name;
  else delete names[dir];
  await updateSettings({ profileNames: names });
}

/**
 * Removes the profile from the app (picker, menus, "All profiles"); its folder, sessions and sign-in stay.
 * The picker's "Show hidden profiles" brings it back. A profile in view gives way to All profiles.
 */
export async function hideProfile(dir: string): Promise<void> {
  const hidden = settings().hiddenProfiles;
  if (hidden.includes(dir)) return;
  if (store.get().currentProfile === dir) store.set({ currentProfile: null });
  await updateSettings({ hiddenProfiles: [...hidden, dir] });
}

export async function showProfile(dir: string): Promise<void> {
  await updateSettings({ hiddenProfiles: settings().hiddenProfiles.filter((d) => d !== dir) });
}

/** The profile a new session starts with: the one in view, else settings.account, else the first one. */
export function startProfile(): string | null {
  const s = store.get();
  if (s.currentProfile !== null) return s.currentProfile;
  const account = s.settings.account;
  const known = account ? s.profiles.find((p) => samePath(p.dir, account, s.platform.os)) : undefined;
  return known?.dir ?? s.profiles[0]?.dir ?? null;
}

/** The profile's email, "Not signed in" without one; null = all profiles. */
export function profileEmail(dir: string | null): string {
  if (dir === null) return T.allProfilesSub;
  return profiles().find((p) => p.dir === dir)?.email ?? T.notSignedIn;
}

/** A profile's round picture: coloured with white ink, or control-coloured with text ink for all profiles. */
export function profileAvatar(dir: string | null, size: number, label?: string): HTMLElement {
  const name = dir === null ? null : profileName(dir);
  const el = avatar({ text: profileInitial(name), color: profileColor(name), size, label });
  if (dir === null) el.classList.add("prof-avatar-all");
  return el;
}

/** Turns finish notifications on or off (settings.notify). Turning them on asks macOS for permission. */
export async function setNotifications(on: boolean): Promise<void> {
  await updateSettings({ notify: on });
  if (!on || !isMac()) return;
  try {
    if (await isPermissionGranted()) return;
    if ((await requestPermission()) !== "granted") {
      toast("Notifications are turned off for Claude Manager.\nTurn them on in System Settings > Notifications.");
    }
  } catch (e) {
    log.warn(`notification permission: ${describeError(e)}`);
  }
}

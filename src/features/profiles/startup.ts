// Which screen the app starts on, and entering a profile (ClaudeManager.ps1 Enter-Profile and Form.Load).

import type { Profile } from "../../bindings/Profile";
import type { Settings } from "../../bindings/Settings";
import { $ } from "../../core/dom";
import { samePath } from "../../core/paths";
import { updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { toast } from "../../ui/toast";

export type StartChoice = { picker: true } | { picker: false; dir: string | null };

/**
 * The picker shows when the setting asks for it, when no profile was entered before, or when the last one
 * is no longer a profile; otherwise the app opens on "all" or the last profile (as discovery spells it).
 */
export function startChoice(
  s: Pick<Settings, "showPicker" | "lastProfile">,
  profiles: readonly Profile[],
  os: string,
): StartChoice {
  const last = s.lastProfile?.trim();
  if (s.showPicker || !last) return { picker: true };
  if (last === "all") return { picker: false, dir: null };
  const known = profiles.find((p) => samePath(p.dir, last, os));
  return known ? { picker: false, dir: known.dir } : { picker: true };
}

/** A discovered profile folder for `dir` (any spelling); undefined when it is not a profile. */
export function knownProfile(dir: string): string | undefined {
  const s = store.get();
  return s.profiles.find((p) => samePath(p.dir, dir, s.platform.os))?.dir;
}

/** The sidebar's list takes the keyboard after a profile is entered (as the Windows app's project list). */
function focusSidebar() {
  const slot = $("#sidebar-slot");
  const target =
    slot.querySelector<HTMLElement>('[role="tree"], [role="listbox"], [role="grid"]') ??
    slot.querySelector<HTMLElement>('[tabindex="0"], nav, button, select');
  target?.focus({ preventScroll: true });
}

/**
 * Enters a profile (null = all profiles): it becomes the profile in view, is remembered as the last one
 * (and as the account for new sessions) and the main screen shows.
 */
export function enterProfile(dir: string | null, opts: { focus?: boolean } = {}): void {
  const known = dir === null ? null : knownProfile(dir);
  if (known === undefined) {
    toast(`That profile no longer exists:\n${dir}`, { kind: "error" });
    return;
  }
  store.set({ currentProfile: known, screen: "main" });
  void updateSettings(known === null ? { lastProfile: "all" } : { account: known, lastProfile: known });
  if (opts.focus !== false) requestAnimationFrame(focusSidebar);
}

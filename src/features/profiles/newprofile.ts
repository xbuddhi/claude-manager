// "Add profile" (ClaudeManager.ps1 Do-NewProfile): ask for a name, create ~/.claude-<name>, start claude in
// the home folder with it inside the app (its first run asks to log in), and enter the new profile.

import { call } from "../../core/api";
import { emit } from "../../core/bus";
import { profiles } from "../../core/profiles";
import { store } from "../../core/store";
import { input, message } from "../../ui/dialog";
import { enterProfile } from "./startup";
import { T } from "./strings";

/** Letters, numbers, - and _ (the Windows app's ^[\w-]+$), at most 64 characters; the backend checks the same. */
export function validProfileName(name: string): boolean {
  return /^[\p{L}\p{N}_-]+$/u.test(name) && [...name].length <= 64;
}

/** The home folder and separator for the prompt, from the default profile's folder (`<home>/.claude`). */
export function homeHint(defaultDir: string | undefined): { home: string; sep: string } {
  const sep = defaultDir?.includes("\\") ? "\\" : "/";
  const cut = defaultDir ? Math.max(defaultDir.lastIndexOf("/"), defaultDir.lastIndexOf("\\")) : -1;
  return cut > 0 ? { home: defaultDir?.slice(0, cut) ?? "~", sep } : { home: "~", sep: "/" };
}

let busy = false;

export async function newProfile(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const { home, sep } = homeHint(profiles().find((p) => p.isDefault)?.dir);
    const typed = await input(`${T.newTitle}\n${T.newPrompt(home, sep)}`, { okLabel: "Create" });
    if (typed === null) return;
    const name = typed.trim();
    if (!name) return;
    if (!validProfileName(name)) {
      await message(T.badName, "warning");
      return;
    }
    const res = await call("create_profile", { name });
    if (!res.ok) return;
    // the backend has refreshed the profile list (profiles-changed) before answering; make sure it is in
    // the store before entering, in case the event arrives after this reply
    const listed = await call("list_profiles", undefined, { quiet: true });
    if (listed.ok) store.set({ profiles: listed.value });
    enterProfile(res.value.dir, { focus: false });
    emit("launch", { dir: res.value.home, profile: res.value.dir, mode: "embed" });
  } finally {
    busy = false;
  }
}

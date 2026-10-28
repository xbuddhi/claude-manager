// The discovered Claude Code profiles (store.profiles), kept current by `profiles-changed`, with the names
// given to them in the app (settings.profileNames) in place of the folder names. Profiles removed from the
// app (settings.hiddenProfiles) go to store.hiddenProfiles instead.
// Profile UI (picker, avatar, colours) belongs to the profiles feature (WP6).

import type { Profile } from "../bindings/Profile";
import { call, listen } from "./api";
import { on } from "./bus";
import { leaf } from "./format";
import { store } from "./store";

export function profiles(): Profile[] {
  return store.get().profiles;
}

/** Display name of a profile folder ("default", "work"), hidden ones too; the folder name when it is not a known profile. */
export function profileName(dir: string): string {
  const s = store.get();
  return (s.profiles.find((p) => p.dir === dir) ?? s.hiddenProfiles.find((p) => p.dir === dir))?.name ?? leaf(dir);
}

/** The profiles as discovered (folder names). */
let discovered: Profile[] = [];

/** `list` with the names the user gave (by folder) in place of the folder names. */
export function withNames(list: readonly Profile[], names: Readonly<Record<string, string | undefined>>): Profile[] {
  return list.map((p) => {
    const name = names[p.dir]?.trim();
    return name && name !== p.name ? { ...p, name } : p;
  });
}

/** Splits the named profiles into the ones shown and the hidden ones. */
export function splitHidden(
  list: readonly Profile[],
  hidden: readonly string[],
): { shown: Profile[]; hidden: Profile[] } {
  const out = new Set(hidden);
  return { shown: list.filter((p) => !out.has(p.dir)), hidden: list.filter((p) => out.has(p.dir)) };
}

function apply() {
  const { profileNames, hiddenProfiles } = store.get().settings;
  const { shown, hidden } = splitHidden(withNames(discovered, profileNames), hiddenProfiles);
  store.set({ profiles: shown, hiddenProfiles: hidden });
}

function publish(list: Profile[]) {
  discovered = list;
  apply();
}

export async function initProfiles(): Promise<void> {
  await listen("profiles-changed", publish);
  // a full refresh also rediscovers profiles (a new ~/.claude-* folder, a changed sign-in)
  on("refresh:full", () => void call("refresh_profiles"));
  store.select((s) => [s.settings.profileNames, s.settings.hiddenProfiles] as const, apply, {
    equals: (a, b) => a[0] === b[0] && a[1] === b[1],
  });
  const res = await call("list_profiles");
  if (res.ok) publish(res.value);
}

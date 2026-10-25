// The discovered Claude Code profiles (store.profiles), kept current by `profiles-changed`.
// Profile UI (picker, avatar, colours) belongs to the profiles feature (WP6).

import type { Profile } from "../bindings/Profile";
import { call, listen } from "./api";
import { on } from "./bus";
import { leaf } from "./format";
import { store } from "./store";

export function profiles(): Profile[] {
  return store.get().profiles;
}

/** Display name of a profile folder ("default", "work"); the folder name when it is not a known profile. */
export function profileName(dir: string): string {
  return profiles().find((p) => p.dir === dir)?.name ?? leaf(dir);
}

export async function initProfiles(): Promise<void> {
  await listen("profiles-changed", (list) => store.set({ profiles: list }));
  // a full refresh also rediscovers profiles (a new ~/.claude-* folder, a changed sign-in)
  on("refresh:full", () => void call("refresh_profiles"));
  const res = await call("list_profiles");
  if (res.ok) store.set({ profiles: res.value });
}

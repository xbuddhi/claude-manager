// Public API of the profiles feature (WP6). Other features may import this file only.
// These follow the spec ("Profile discovery, names, colors, email" and the start-profile rule) and already
// work; WP6 owns them and keeps the names and signatures.

import { samePath } from "../../core/paths";
import { profileName } from "../../core/profiles";
import { store } from "../../core/store";

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

/** The profile a new session starts with: the one in view, else settings.account, else the first one. */
export function startProfile(): string | null {
  const s = store.get();
  if (s.currentProfile !== null) return s.currentProfile;
  const account = s.settings.account;
  const known = account ? s.profiles.find((p) => samePath(p.dir, account, s.platform.os)) : undefined;
  return known?.dir ?? s.profiles[0]?.dir ?? null;
}

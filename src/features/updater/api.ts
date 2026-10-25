// Public API of the updater feature (WP10). Other features may import this file only.
// Updates are "disabled" until the build carries a release endpoint and a signing key (owner decision,
// docs/port/README.md); the release workflow adds them once a repository and keys exist.

import { checkForUpdate } from "./updater";

export type UpdateCheck =
  | { kind: "disabled" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "failed"; message: string };

/** Checks for an update now (Settings > "Check for updates"). An available update also shows the banner. */
export async function checkNow(): Promise<UpdateCheck> {
  return checkForUpdate(false);
}

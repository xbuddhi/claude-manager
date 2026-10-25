// Public API of the updater feature (WP10). Other features may import this file only.
// Stub provided by WP10, which replaces the body only. Updates stay disabled until a release endpoint and
// a signing key exist (owner decision, docs/port/README.md), and then this still reports "disabled".

export type UpdateCheck =
  | { kind: "disabled" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "failed"; message: string };

/** Checks for an update now (Settings > "Check for updates"). */
export async function checkNow(): Promise<UpdateCheck> {
  return { kind: "disabled" };
}

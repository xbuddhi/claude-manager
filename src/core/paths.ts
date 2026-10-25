// Path comparison keys, the same as the backend's core::paths::key(): Windows and default macOS volumes
// are case-insensitive, so two spellings of one folder must give one key there. Use pathKey() wherever
// folders are matched (store.liveCwd keys, pinned folders, group membership).

/** Trims trailing `/` and `\`, keeping a root such as `/` or `C:\` intact. */
export function normPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  // "/" or "C:\" itself: keep one separator so it still names the root
  if (trimmed === "" || trimmed.endsWith(":")) return path.slice(0, trimmed.length + 1);
  return trimmed;
}

/** Comparison key for a path on `os` ("windows", "macos", "linux"; see PlatformInfo.os). */
export function pathKey(path: string, os: string): string {
  const n = normPath(path);
  if (os === "windows") return n.replaceAll("/", "\\").toLowerCase();
  if (os === "macos") return n.toLowerCase();
  return n;
}

/** Whether two paths name the same folder on `os`. */
export function samePath(a: string, b: string, os: string): boolean {
  return pathKey(a, os) === pathKey(b, os);
}

// User-facing texts of the profiles feature, as the Windows app words them (ClaudeManager.ps1).

export const T = {
  renamePrompt:
    "Rename profile\nThe name shown in Claude Manager. The profile's folder stays as it is; leave it empty for the folder's name.",
  rename: "Rename…",
  hide: "Remove from app",
  unhide: "Show in app",
  hiddenCard: "Hidden · click to show",
  showHidden: (n: number) => `Show ${n} hidden profile${n === 1 ? "" : "s"}`,
  hideHidden: "Hide hidden profiles",
  renameTip: "Rename profile (F2)",
  pickerTitle: "Who's using Claude Code?",
  pickerSub:
    "Pick a profile to see its projects and sessions. Switch any time from the profile button at the top left.",
  pickerSubtitle: "Choose a profile",
  showPicker: "Show this screen when the app starts",
  addProfile: "Add profile",
  addProfileSub: "Sign in to another account",
  allProfiles: "All profiles",
  allProfilesSub: "Sessions from every profile",
  notSignedIn: "Not signed in",
  switchTo: "Switch to",
  manageProfiles: "Manage profiles",
  openFolder: "Open profile folder",
  openFolderMac: "Show in Finder",
  notifications: "Finish notifications",
  explorerAdd: "Add Explorer right-click menu",
  explorerRemove: "Remove Explorer right-click menu",
  refreshAll: "Refresh everything",
  closeOrphans: "Close background sessions",
  settings: "Settings...",
  newTitle: "New Claude profile",
  newPrompt: (home: string, sep: string) =>
    `Name for the new profile (letters, numbers, - or _).\nIt will be stored in ${home}${sep}.claude-<name>`,
  badName: "That name can't be used\nUse letters, numbers, - or _ only.",
  notAvailable: (what: string) => `${what} is not available yet.`,
} as const;

/** "1 session", "2 sessions". */
export function sessionCount(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}

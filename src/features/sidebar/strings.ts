// Every user-visible text of the sidebar, worded as in the Windows app (ClaudeManager.ps1, MacUI.cs Tree).

export const S = {
  title: "Workspace",
  addTip: "New project or folder",
  treeLabel: "Projects and folders",

  projects: "PROJECTS",
  folders: (n: number) => `FOLDERS  ·  ${n}`,
  showMore: (n: number) => `Show ${n} more`,
  showLess: "Show less",
  showHidden: (n: number) => `Show ${n} hidden`,
  hiddenHeading: (n: number) => `HIDDEN  ·  ${n}`,
  hiddenTip: "Click to fold the hidden folders away",
  dragHere: "Drag folders here",
  noProjects: "No projects yet. Click + to create one.",
  noMatches: "No matching projects",

  loading: "Loading...",
  noSessions: "No Claude Code sessions found",
  loadError: "Could not read the sessions",
  retry: "Retry",

  newProject: "New project...",
  addFolder: "Add folder...",
  pickFolder: "Pick a project folder",

  newProjectPrompt: "New project\nName for the new project. Folders are only referenced here, never moved.",
  renamePrompt: "Rename project\nNew name:",
  exists: (name: string) => `A project named '${name}' already exists.`,
  deleteAsk: (name: string, n: number) =>
    `Delete the project '${name}'?\n\nIts ${n} folder(s) go back to Ungrouped. No folders or sessions are deleted.`,
  deleteCaption: "Delete project",

  newSession: "New session",
  newSessionWindow: "New session in new window",
  newSessionApp: "New session inside app",
  newSessionProfile: "New session with profile",
  continueLast: "Continue last session",
  openCode: "Open in VS Code",
  copyPath: "Copy path",
  openOn: "Open on",
  moveTo: "Move to project",
  removeFrom: "Remove from project",
  pin: "Pin",
  unpin: "Unpin",
  hide: "Hide from sidebar",
  unhide: "Show in sidebar",
  deleteAll: "Delete all sessions...",
  newSessionIn: "New session in...",
  startWhich: (name: string) => `Start in which folder of '${name}'?`,
  noFolders: "(no folders yet - drag some in)",
  renameProject: "Rename project...",
  deleteProject: "Delete project",

  dropHint: "Drop folders to pin them and start a session in each",
  subtitle: (who: string, sessions: number, folders: number, projects: number) => {
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const parts = [n(sessions, "session"), n(folders, "folder")];
    if (who) parts.unshift(who);
    if (projects) parts.push(n(projects, "project"));
    return parts.join(" · ");
  },
};

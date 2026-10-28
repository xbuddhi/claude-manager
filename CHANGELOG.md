# Changelog

All notable changes to Claude Manager. Versions are `X.Y.Z`; each release is tagged `vX.Y.Z`.

## 0.1.3 - 2026-10-29

### Added

- Interface skins (Settings → Appearance): Claude, Modern, Mono, Paper, Linear and Graphite, each dark and
  light. Terminal colours set to "Default" follow the skin; new Graphite terminal scheme.
- macOS: optional window glass (the desktop blurs through the title bar and sidebar).
- Files view: a .gitignore-aware tree of the selected folder with a read-only preview; new, rename, move,
  duplicate and move to trash. Drag a file onto a terminal to paste its path.
- Collapsible files and source control panels beside a terminal.
- Profile companions: each profile gets its own small companion as its avatar (choose another from the
  picker card); All profiles shows them huddled together.
- Rename profiles, and remove a profile from the app (only hidden; its files stay as they are).
- Archive sessions: they leave the list and come back from Archived · N.
- Hide folders from the sidebar's FOLDERS list; a "Show N hidden" row lists them.
- Source control: a Claude-written commit message (sparkle button, Sonnet through your `claude`); a commit
  hover card and a compact, VS Code-like history graph; Sync Changes / Publish Branch when there is nothing
  to commit; pull and push counts as badges on the icons.
- Branches: search the branch menu, and switch branch from a terminal's bar (refuses with conflicts, asks
  about uncommitted changes or a working Claude).
- Open the repository on GitHub from the Open menu and a folder's menu.
- Title bar counts shown as icons, with a tooltip.

### Changed

- Faster and lighter: the session index sends only what changed, session text loads on demand and is
  searched in Rust, fewer redraws, and lower idle CPU (PTY, live scan, git).
- macOS: the traffic lights are centred on the title bar; a larger profile chip.
- Undo last commit puts the message back in the commit box.

## 0.1.2 - 2026-10-28

### Fixed

- Windows: the app no longer crashes at startup (heap corruption while writing the taskbar Jump List). 0.1.1
  cannot start on Windows, so it cannot update itself: install 0.1.2 from the release.

## 0.1.1 - 2026-10-28

First cross-platform release: the Windows PowerShell app rebuilt with Tauri 2 for Windows and macOS.

### Added

- Memory view beside Sessions and Source Control: the `CLAUDE.md` files and auto memory Claude Code loads for
  the selected folder under a profile, shown as documents, with Open in VS Code, Reveal and Create.
- Source control diffs in colour (Monokai Pro Spectrum / Light), an Inline or Side by side layout, and the
  changed words marked inside replaced lines.
- Rename a session from its menu (like Claude Code's `/rename`).
- Dock menu (macOS) and taskbar Jump List (Windows): New Session and New Window.
- Dragging a tab toward another window shows where it will land there.
- macOS 12 or later (Apple Silicon and Intel, one universal app), next to Windows 10 and 11.
- Terminal tabs on a real pseudo-terminal (ConPTY on Windows) with xterm.js.
- Per-user Windows installer (NSIS, no admin rights; installs WebView2 when missing) and a macOS dmg.
- In-app updates: checks at startup and every 24 hours, downloads with progress and restarts into the new
  version (on in release builds that have an updater key).
- New app icon and a macOS menu bar icon.
- Release workflow: a `vX.Y.Z` tag builds a draft GitHub release; signing, notarization and updates turn on
  when their secrets are set.
- Logs in the app's log folder, and a settings import from the old app on the first run.

### Fixed

- macOS: double-clicking a session opens it.
- macOS: Move to new window shows the new window.
- Pressing the button that opened a menu closes the menu instead of opening it again.
- No focus ring around whole lists on macOS; the session details pane is as tall as its text; a project's
  folders show by name under their shared parent.

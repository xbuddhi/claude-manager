# Changelog

All notable changes to Claude Manager. Versions are `X.Y.Z`; each release is tagged `vX.Y.Z`.

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

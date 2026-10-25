# Changelog

All notable changes to Claude Manager. Versions are `X.Y.Z`; each release is tagged `vX.Y.Z`.

## Unreleased

First cross-platform release: the Windows PowerShell app rebuilt with Tauri 2 for Windows and macOS.

### Added

- macOS 12 or later (Apple Silicon and Intel, one universal app), next to Windows 10 and 11.
- Terminal tabs on a real pseudo-terminal (ConPTY on Windows) with xterm.js.
- Per-user Windows installer (NSIS, no admin rights; installs WebView2 when missing) and a macOS dmg.
- In-app updates: checks at startup and every 24 hours, downloads with progress and restarts into the new
  version (on in release builds that have an updater key).
- New app icon and a macOS menu bar icon.
- Release workflow: a `vX.Y.Z` tag builds a draft GitHub release; signing, notarization and updates turn on
  when their secrets are set.
- Logs in the app's log folder, and a settings import from the old app on the first run.

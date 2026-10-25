# Claude Manager (cross-platform prototype)

Tauri 2 version of Claude Manager for Windows and macOS. Lists your Claude Code projects and sessions from
`~/.claude` and `~/.claude-*`, and runs `claude` in tabs (xterm.js on a real PTY: ConPTY on Windows,
a pseudo-terminal on macOS).

## Run

```
pnpm install
pnpm tauri dev      # dev build with hot reload
pnpm tauri build    # release build + installer for this OS
```

## Layout

- `src-tauri/src/sessions.rs` - reads transcripts into projects/sessions (same rules as the Windows app)
- `src-tauri/src/pty.rs` - terminal tabs: spawns `claude` in a PTY, streams output to the window
- `src/main.ts` - sidebar, Home view, tabs, xterm.js terminals

## macOS build without a Mac

`.github/workflows/build.yml` builds a universal `.dmg` on GitHub's macOS machines. Run it from the
Actions tab, then download the artifact. It is unsigned: on the Mac, right-click > Open the first time.
For signed, notarized releases add an Apple Developer certificate and `APPLE_*` secrets
(see https://v2.tauri.app/distribute/sign/macos/).

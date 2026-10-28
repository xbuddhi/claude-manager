# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Claude Manager: a Tauri 2 desktop app (Windows + macOS) that lists Claude Code projects/sessions from `~/.claude`
and every `~/.claude-*` profile and runs `claude` in xterm.js tabs on a real PTY. It is a port of the legacy
PowerShell app (`../ClaudeManager.ps1`, `../MacUI.cs`), which are read-only references. Full developer guide:
`docs/port/FOUNDATION.md` (decisions in `docs/port/README.md` override `plan.json`).

## Commands

Setup in a fresh worktree (`tauri::generate_context!` needs `../dist`, so build before any cargo command; for
cargo checks alone an empty `dist/index.html` is enough):

```sh
pnpm install --frozen-lockfile
pnpm build
```

On the Windows workstation every cargo command needs (the pinned 1.94.1 is installed under the name `stable`):

```powershell
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'; $env:RUSTUP_AUTO_INSTALL='0'
```

```sh
pnpm tauri dev                       # run with hot reload
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm format                          # biome: fix formatting + import order
pnpm vitest run src/core/format.test.ts   # one frontend test file (-t "name" for one test)

# in src-tauri/
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked                  # also regenerates src/bindings/*.ts — commit them
cargo test --locked <name_filter>    # one Rust test

node --test "scripts/*.test.mjs"     # script tests (release workflow)
```

All checks must pass; CI (`.github/workflows/ci.yml`) runs them on Windows and macOS. After `cargo test`,
`git status --porcelain -- src/bindings` must be empty. A cold cargo build takes ~15 min: run it in the
background with a long timeout.

Release: `node scripts/bump-version.mjs X.Y.Z` (single version source is `src-tauri/Cargo.toml`), update
`CHANGELOG.md`, `node scripts/third-party-notices.mjs`, commit, push tag `vX.Y.Z`. That creates a draft release.

## Architecture

**Rust backend (`src-tauri/src/`)**: `lib.rs` only builds the app and registers features. Each feature is a
folder module (`sessions`, `pty`, `launch`, `live`, `notify`, `fsutil`, `actions`, `profiles_cmd`, `usage`,
`git`, `os`, `updater`) with an optional `init(app)`. Registration lines go under marker comments in `lib.rs`;
all commands are listed in `commands.rs` and event names in `core/events.rs`, one marked block per feature.
Keep new lines inside the right block. `core/` is shared: `error` (AppError `{code,message}`, `blocking()`),
`paths` (OS-specific path keys, `is_within`), `env` (resolves claude/shell/git, clean env, `apply_profile`
sets `CLAUDE_CONFIG_DIR`), `spawn`, `procs`, `profiles`, `settings`, `lifecycle` (quit/close hooks), `webview`.
- Commands are `async`, return `AppResult<T>`, and run blocking work through `core::error::blocking`.
- IPC types: `#[derive(Serialize, TS)] #[serde(rename_all = "camelCase")] #[ts(export)]` in the feature's
  module. Only shared types go in `core/types.rs` (add fields only, never rename or remove).

**Frontend (`src/`, vanilla TS + Vite, no framework)**: `core/app.ts` loads platform, settings and profiles,
mounts the shell and then each `features/<name>/index.ts` (listed in `features/index.ts`). The window stays
hidden until `beforeShow()` finishes.
- State: one `store` (`core/store.ts`). Each feature adds its own fields by declaration merging in its `state.ts`.
- `core/bus.ts`: events between features.
- `core/api.ts`: `call()`/`listen()` for the backend. `call()` never throws; it returns a Result and shows
  errors as a toast.
- Features import each other only through `api.ts`. Render only into the shell slots or a `registerView` view.
- Styles: one css file per feature with a class prefix (`ses-`, `git-`, `term-`, …). Colours only from `styles/tokens.css`.
- `src/bindings/` is generated. Never edit it by hand.
- Selectors, lists and caches compare by reference: keep unchanged values as the same object (helpers like
  `projectsFor()` must not return fresh copies).

**Data flow**: sessions come from `<profile>/projects/*/*.jsonl` (file watcher → index). Live/busy state comes
from `<profile>/sessions/<pid>.json` or `<pid>.<hash>.key`, matched against the process table. `get_index(sinceGen)`
sends only changed projects. Sessions carry a short `label`; full text comes from `session_text`, text search
from `search_sessions`.

## Rules

- Security: the webview never sends executables, arguments or env. It sends only session UUIDs (checked with
  `profiles::is_session_id`), profile dirs (checked with `profiles::resolve_profile`) and existing folders. Paths
  to delete must pass `paths::is_within`. Tokens stay in Rust and are never logged.
- `~/.claude*` folders are read-only: never write there, not even in tests. Use `tempfile::tempdir()` fixtures.
- Never kill processes you didn't start (the user runs their own `claude.exe` and a "Claude Sessions" pwsh window).
- Don't edit `Cargo.toml`/`Cargo.lock`/`package.json`/`pnpm-lock.yaml` unless a new dependency is really needed.
- Clickable elements inside `#titlebar` / `#tabstrip-slot` must be `<button>`s, because those areas are drag regions.
- Command/menu ids are `<area>:<action>` (contract in `src-tauri/src/os/menu.rs`).
- macOS-only code is not compiled on this Windows machine; the macOS CI job is the first to build it.
- The app must stay unsandboxed on macOS.
- Commits: `<type>: <description>` (Conventional Commits, no scope, imperative, lowercase, no period, ≤72 chars);
  body only when needed, 1-4 short `- ` bullets; breaking change: `!` + `BREAKING CHANGE:` footer; no other
  trailers (no Co-Authored-By).

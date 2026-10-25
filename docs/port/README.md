# Port plan (from the mapping run, 2026-10-25)

- `plan.json` - tech-lead plan: feature_list (spec per feature), architecture, foundation_tasks, work_packages, release_checklist, risks
- `features.json` - raw inventory of the Windows app (ClaudeManager.ps1 + MacUI.cs), 156 items with source refs
- `findings.json` - production-readiness audit of the prototype, 103 findings
- `research.md` - how Claude Code stores credentials, live markers and transcripts on macOS vs Windows
- `FOUNDATION.md` - developer guide for the work packages: the foundation as built, how to add a feature, the cross-package stubs

## Decisions by the owner (override the plan)
- Identity: bundle identifier `com.xbuddhi.claudemanager`, publisher `xbuddhi`, product name "Claude Manager".
- No GitHub repo yet: build the release workflow and updater fully, but keep the updater disabled (no endpoint/pubkey active) until a repo and signing keys exist. Nothing is pushed or published.

## Decisions taken while building the foundation (override the plan where they differ)
- **Toolchain on this workstation.** `src-tauri/rust-toolchain.toml` pins `1.94.1` (CI installs exactly that). Here the installed toolchain is named `stable` (also 1.94.1), so plain `cargo` would try to download `1.94.1`. Run every cargo command with
  `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc RUSTUP_AUTO_INSTALL=0` (PowerShell: `$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'; $env:RUSTUP_AUTO_INSTALL='0'`).
- **New worktree.** It has no `node_modules` and no `dist/`, and `tauri::generate_context!` needs `../dist`. Run `pnpm install --frozen-lockfile && pnpm build` before any cargo command.
- **Dependencies are all declared.** Every crate, feature flag and npm package the packages plan to use is already in `Cargo.toml`/`Cargo.lock` and `package.json`/`pnpm-lock.yaml`. A package does not edit those four files; if it really needs something new, it says so in its report and the integrator adds it once.
- **Registration markers.** `lib.rs`, `commands.rs`, `core/events.rs`, `src/features/index.ts` and `vite.config.ts` have one marker comment per package. A package adds its lines directly under its own marker and never edits a marker or another package's lines. (Changing adjacent lines conflicts in git; inserting under distinct markers does not.)
- **Feature IPC types live in the feature.** `core/types.rs` holds only types several features share (`Profile`, `Session`, `Project`, `LiveSession`, `Settings`, ...). A type used by one feature's commands or events lives in that feature's module (e.g. `live/types.rs`) with the same ts-rs derive. The terminal list type WP2 adds is named `PtyInfo` in Rust; the frontend's tab record stays `TermInfo` in `core/store.ts`.
- **`open_url_https` is a core command** (`core/open.rs`), not WP9's: the foundation's "Claude Code was not found" banner links the setup guide. `open_log_dir` is core as well.
- **Launch arguments** (`--open <dir> --profile <dir>`) reach the app through `core::open_request`: WP9 installs the parser, the frontend pulls validated requests with `take_open_request` after `app:open-request`. Raw arguments never go to the webview (`app:open-args` is gone).
- **"Keep running" on Windows** minimizes the window until the tray exists; WP9 calls `lifecycle::set_tray_present` once its icon is up, and from then on the window hides. On macOS an exit request from outside the app (Dock Quit, logout, shutdown) is not cancelled: the hooks end the terminals and their sessions stay resumable.
- **Updater (WP10).** `tauri-plugin-updater` is a dependency but is not registered: the plugin fails at startup without a `plugins.updater` config. WP10 registers it under its marker in the builder-extensions block of `lib.rs`, only when an endpoint and public key are configured, and adds `"updater:default"` to `capabilities/default.json` (WP10 may edit that one line).
- **Search belongs to WP5.** The temporary search box lives in `src/features/search/` and owns `store.searchQuery`; WP4 never touches search.

## Rules every package follows (in addition to plan.json)
- **Title-bar drag region.** `#titlebar` and `#tabstrip-slot` are `data-tauri-drag-region="deep"`: a mousedown on any element inside them that is not a button or input and has no interactive role or tabindex starts a window drag, and the click never arrives. Anything clickable placed there (avatar WP6, usage ring WP7, tab overflow WP2) must be a `<button>` (or have an interactive role and tabindex).
- **Command and menu ids** are `<area>:<action>` with a colon (`session:new`, `tab:close`, `tab:next`, `tab:prev`, `search:focus`, `refresh:full`, `app:settings`, `help:logs`, `app:quit`), as defined in `src-tauri/src/os/menu.rs`. The dotted ids in the WP9 plan text are superseded. Anything that triggers one of these actions (tray menu, native menu, shortcut) uses the same id. The one exception is the tray's "New session", which emits `menu` with `tray:new-session` so it runs without the window-focus check.
- **macOS-only code is not compiled on this workstation.** The macOS/Unix parts of `os/menu.rs`, `core/lifecycle.rs`, `core/env.rs` and `core/procs.rs` are compiled for the first time by the macOS CI job. Do not start macOS-only work until that job is green.

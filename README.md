# Claude Manager

A desktop app for Windows and macOS that lists your Claude Code projects and sessions from `~/.claude` and
every `~/.claude-*` profile, and runs `claude` in tabs: start, resume and fork sessions, see which ones are
working, and review changes with source control. Built with Tauri 2 (Rust) and xterm.js on a real
terminal (ConPTY on Windows, a pseudo-terminal on macOS).

## Install

- **Windows 10 or 11:** download `Claude Manager_<version>_x64-setup.exe` from the release and run it. It
  installs for the current user only (no admin rights). On Windows 10 without WebView2 the installer
  downloads it.
- **macOS 12 or later (Apple Silicon and Intel):** download `Claude Manager_<version>_universal.dmg`, open it
  and drag Claude Manager to Applications.

**Unsigned builds.** A build made without signing secrets is not code-signed (the release notes say so).

- Windows: SmartScreen may say "Windows protected your PC". Choose **More info > Run anyway**.
- macOS: right-click > Open no longer works on macOS 15. After the first attempt to open the app, go to
  **System Settings > Privacy & Security** and choose **Open Anyway**, or run
  `xattr -dr com.apple.quarantine "/Applications/Claude Manager.app"`.

Uninstall: Windows **Settings > Apps > Claude Manager > Uninstall** (also removes the Explorer menu entries);
macOS: move the app to the Bin. Your settings and logs stay; delete the folders below to remove them.

## Requirements

- **Claude Code CLI** (`claude`), installed and signed in: https://code.claude.com/docs/en/setup. The app shows
  a banner when it cannot find `claude`.
- Windows 10 or 11 (WebView2, installed by the installer when missing), or macOS 12 or later.
- `git` on PATH for the source control view (optional).

## Where data lives

The app only reads `~/.claude` and `~/.claude-*` (it never writes there). Its own files:

|                                | Windows                                         | macOS                                                     |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------------------- |
| Settings (`settings.json`)     | `%APPDATA%\com.xbuddhi.claudemanager`           | `~/Library/Application Support/com.xbuddhi.claudemanager` |
| Cache                          | `%LOCALAPPDATA%\com.xbuddhi.claudemanager`      | `~/Library/Caches/com.xbuddhi.claudemanager`              |
| Logs (5 MB, one old file kept) | `%LOCALAPPDATA%\com.xbuddhi.claudemanager\logs` | `~/Library/Logs/com.xbuddhi.claudemanager`                |

On the first run on Windows, settings are imported once from the old
PowerShell app (`%APPDATA%\ClaudeManager\settings.json`); that file is left as it is.

**macOS privacy.** Claude Code sessions you start run in your project folders, so macOS may ask whether Claude
Manager may access Documents, Desktop, Downloads or other volumes. The app is not sandboxed and must stay
that way: the App Sandbox would block reading `~/.claude*` and running `claude`. It uses the hardened runtime
and needs no entitlements file.

## Development

Needs Node 22, pnpm (the version in `package.json` `packageManager`) and Rust (the version pinned in
`src-tauri/rust-toolchain.toml`).

```
pnpm install
pnpm tauri dev      # dev build with hot reload
pnpm tauri build    # release build + installer for this OS (unsigned, no updater files)
```

Checks (`.github/workflows/ci.yml` runs the first two lines; the release workflow runs the script tests):

```
pnpm lint && pnpm typecheck && pnpm test && pnpm build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
node --test "scripts/*.test.mjs"
```

`cargo test` also regenerates the TypeScript bindings in `src/bindings`; commit them. The developer guide is
`docs/port/FOUNDATION.md`.

Other scripts:

- `node scripts/make-icons.mjs` then `pnpm tauri icon app-icon.png`: rebuild the app icon and the macOS tray icon.
- `node scripts/third-party-notices.mjs`: regenerate `THIRD_PARTY_NOTICES` after changing dependencies.

## Releasing

The version has one source: `version` in `src-tauri/Cargo.toml`. Versions are plain numbers (`X.Y.Z`).

1. `node scripts/bump-version.mjs 1.2.0` (updates Cargo.toml, Cargo.lock and package.json).
2. Add the changes to `CHANGELOG.md`, run `node scripts/third-party-notices.mjs`, commit.
3. `git tag v1.2.0 && git push origin v1.2.0`.
4. `.github/workflows/release.yml` checks that the tag matches the version, builds the Windows installer and
   the universal macOS dmg, and uploads them to a **draft** GitHub release. Check it, then publish it.

Each part below turns on when its secrets and variables are set in the repository (Settings > Secrets and
variables > Actions). Without them the build still succeeds, unsigned, and the release notes say what is
missing. `.github/workflows/build.yml` makes unsigned test builds on demand (Actions > build > Run workflow).

| Part                                            | Secrets                                                                                   | Variables                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| In-app updates (`latest.json` and `.sig` files) | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                         | `UPDATER_PUBKEY`                                                           |
| macOS signing                                   | `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` |                                                                            |
| macOS notarization (needs signing)              | `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`                     |                                                                            |
| Windows signing (Azure Trusted Signing)         | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`                               | `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` |

**Updater key.** Make it once with `pnpm tauri signer generate -w ~/.tauri/claude-manager.key`, keep the
private key and its password offline, put them in the two secrets, and put the public key in
`UPDATER_PUBKEY`. Never commit the key. If it is lost, installed copies can no longer update. The updater
reads `https://github.com/<owner>/<repo>/releases/latest/download/latest.json` (from the repository the
release runs in), so a release only reaches users once it is published. The app checks at startup and every
24 hours, shows "Update available", and restarts into the new version. Builds without the updater config
(local builds, `build.yml`) have updates turned off.

## License

See `LICENSE`. Third-party software and its licenses: `THIRD_PARTY_NOTICES`. Changes: `CHANGELOG.md`.

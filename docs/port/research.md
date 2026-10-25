# Claude Code data on macOS and Windows: technical brief

I made no edits. I did not print or read any secret values. I only looked at key names, and I did not open the `*.key` files.

Short version:
- **Credentials:** these are the one real difference between the platforms. Windows and Linux keep them in a file; macOS keeps them in the Keychain.
- **Usage endpoint:** the call and its parsing work the same on both. Only the place you read the token from changes.
- **Session marker files and transcripts:** same layout on macOS. The main macOS-specific risk is the process-name check (see 3).
- **Finding `claude`:** a GUI app on macOS must look in known folders or ask a login shell, because it does not get the user's shell PATH.

## 1. OAuth credentials

**Windows and Linux** (local evidence: `C:\Users\<you>\.claude\.credentials.json`, `.claude-work` and `.claude-personal`)
- File: `<configDir>/.credentials.json`. `configDir` is `CLAUDE_CONFIG_DIR`, or `~/.claude` when it is not set.
- On Linux the file has mode 0600.
- Layout: `{"claudeAiOauth":{accessToken, refreshToken, expiresAt(ms epoch, number), refreshTokenExpiresAt(ms), scopes[], subscriptionType, subscriptionTypeSource, rateLimitTier}}`
- Local values: `subscriptionType`="pro", `rateLimitTier`="default_claude_ai". `scopes` includes `user:profile` and `user:inference`.
- `.claude-team` and `.claude-happa` have no credentials file.

**macOS** (official docs: https://code.claude.com/docs/en/iam, "Credential management")
- Credentials are in the login Keychain as a generic-password item.
- If the Keychain refuses the write (for example over SSH), Claude Code falls back to `<configDir>/.credentials.json` (0600).
- With `CLAUDE_CONFIG_DIR` set, "keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry."
- The docs do not give the exact item name.

**Item names** (third-party code, said to be checked against a real install, not official: https://docs.rs/crate/ai-usagebar/0.21.0/source/src/anthropic/keychain.rs)
- Default service: `Claude Code-credentials`
- Per-profile service: `Claude Code-credentials-<h>`. `<h>` is the first 8 lowercase hex characters of SHA-256 over the UTF-8 absolute config-dir path, with no trailing newline.
- Account: `$USER`
- Read command: `/usr/bin/security find-generic-password -s "Claude Code-credentials[-<h>]" -a "$USER" -w`
  - It prints the same JSON as `.credentials.json`.
  - Exit code 44 means the item does not exist.
- Reading it is silent, with no Keychain prompt. Claude Code creates the item through `/usr/bin/security add-generic-password` with no `-T`/`-A`, so `security` is a trusted reader. This was confirmed on 2.1.185, and Anthropic is tracking a tightening of that access rule.
  - Source: https://www.silverfort.com/blog/skipping-the-lock-a-claude-code-cli-weakness-lets-any-macos-process-read-stored-credentials/
  - If that hardening ships, reads may start to prompt or fail.

**UNCONFIRMED**
- Exactly how the path is normalised before hashing (trailing slash, `~` expansion, symlinks, Unicode form).
- Whether setting `CLAUDE_CONFIG_DIR` to `~/.claude` itself gives the hashed name.
- The minimum version for per-dir items. One wrapper says 2.1.144 or later; a June 2026 bug says all profiles shared one item (https://claudeissues.com/issue/70697-bug-claude-config-dir-does-not-isolate-macos-keychain-credentials-per-config-dir).

**Recommended macOS read order for each profile:**
1. The hashed service.
2. The plain `Claude Code-credentials` (default profile only, or as a fallback for older versions).
3. `<configDir>/.credentials.json`.

Never pass the secret on a command line.

## 2. Plan usage endpoint

Taken from `MacUI.cs (the Windows app)`, `Plan.FetchNow`, lines 1910–1966.
- Request: `GET https://api.anthropic.com/api/oauth/usage` with headers:
  - `Authorization: Bearer <claudeAiOauth.accessToken>`
  - `anthropic-beta: oauth-2025-04-20`
  - `User-Agent: claude-manager`
- Pre-checks: if `expiresAt` (ms) is in the past, it does not call and shows "Sign-in expired". Plan name comes from `subscriptionType`.
- 429 handling: honours `Retry-After`, but always waits at least 10 minutes and at most 1 hour. Results are cached for 5 minutes per credentials path.
- 401 is shown as "Sign-in expired".
- Response parsing:
  - Newer layout: `limits[]` with `kind`, `group` ("session"/"weekly"), `scope.model.display_name`, `percent`, `resets_at` (ISO).
  - Older layout used as fallback: `five_hour` / `seven_day` objects with `utilization` and `resets_at`.

**macOS:** the token JSON is identical, so the same request and parsing work unchanged. Only where the token is read from differs.

**Caveats**
- The endpoint is undocumented. Persistent 429s have been reported (https://claudeissues.com/issue/31021-oauth-usage-api-api-oauth-usage-returns-persistent-429-rate-limit).
- The app never refreshes tokens. It relies on Claude Code having been run recently.
- **UNCONFIRMED:** the full current response shape, including `seven_day_opus`/`seven_day_sonnet` and `extra_usage` in the old layout.

## 3. Live-session markers

**Local evidence** (`C:\Users\<you>\.claude-work\sessions\`, Claude Code v2.1.310)
- Files: `<pid>.json` plus `<pid>.<64-hex>.key`. `.claude-personal\sessions` holds only a `.key` file.
- `<pid>.json` fields: `pid`, `sessionId`, `cwd`, `startedAt`(ms), `procStart`, `version`, `peerProtocol`, `peerFeatures[]`, `kind`("interactive"), `entrypoint`("cli"), `pidDomain`("win32:<host>"), `messagingSocketPath` (`\\.\pipe\LOCAL\cc-msg-…`), `name`, `nameSource`, `nameSince`, `updatedAt`, `status`("busy"…), `statusUpdatedAt`.

**macOS:** a macOS/Linux tool reads `~/.claude/sessions/{PID}.json` with `status` values busy / idle / waiting (https://github.com/knowald/cmon). So the folder exists on macOS. There are no official docs; it is internal and could change.

**UNCONFIRMED on macOS**
- The exact values of `pidDomain` and `messagingSocketPath`; probably a Unix socket path instead of a named pipe.
- Whether `.key`-only sessions happen there.

**Porting gotchas in the current `LiveScan` (MacUI.cs:2915–2968)**
- **Process-name check:** it only accepts claude/node/pwsh/cmd/conhost and similar names.
  - On macOS the native binary is `~/.local/share/claude/versions/<version>`, so the process name may be the version string (for example `2.1.310`). UNCONFIRMED, but likely.
  - Better: check `procStart` or `startedAt` against the real process start time instead of the name.
- **Deleting files:** it deletes `<pid>.json` files whose process has ended. That writes into Claude Code's own data folder; consider just ignoring them.
- **Command line:** finding the session from the command line (for `.key`-only cases) needs `ps -o args= -p <pid>` or `sysinfo` on macOS.

## 4. Transcripts

**Layout** (local evidence)
- `<configDir>/projects/<slug>/<sessionId>.jsonl`
- Next to each transcript: a `<sessionId>/subagents/` folder. Each project folder also has a `memory/` folder (MEMORY.md and topic files).

**Slug rule**
- Every character that is not `[A-Za-z0-9]` becomes `-`, and case is kept.
  - Windows: `C:\Users\me` → `C--Users-me`
  - macOS: `/Users/x/my_proj.v2` → `-Users-x-my-proj-v2`
- The rule is lossy: different paths can give the same slug, and non-ASCII characters each become `-`. Sources:
  - https://claudeissues.com/issue/9221-bug-lossy-project-directory-path-encoding-makes-decoding-impossible
  - https://claudeissues.com/issue/45718-project-path-encoding-breaks-with-non-ascii-cyrillic-directory-names
  - https://claudeissues.com/issue/7009-path-encoding-collision-directories-with-dashes-conflict-with-path-separators
- So never decode a slug. Use the `cwd` field inside the JSONL, as the Windows app already does.
- **UNCONFIRMED:** truncation or hashing of very long paths. The longest local slug is 77 characters.

**Record types seen locally**
- `user`, `assistant`, `system`, `summary`, `custom-title`(`customTitle`), `ai-title`(`aiTitle`), `last-prompt`(`lastPrompt`), `permission-mode`, `file-history-snapshot`, `queue-operation`, and others.
- The current parser ignores `ai-title`. It could be added as a title fallback.

**macOS:** the format is the same. Lines end in LF instead of CRLF; the parser already strips `\r`.

## 5. Finding `claude` on macOS

**Install methods** (https://code.claude.com/docs/en/setup)
- **Native installer** (recommended): `curl -fsSL https://claude.ai/install.sh | bash`
  - Launcher: `~/.local/bin/claude`, a symlink into `~/.local/share/claude/versions/<ver>`.
  - Updates itself.
- **Homebrew:** `brew install --cask claude-code` (stable) or `claude-code@latest`.
  - Binary: `/opt/homebrew/bin/claude` on Apple Silicon, `/usr/local/bin/claude` on Intel. (These paths are standard Homebrew locations, not stated in the Claude docs.)
- **npm:** `npm install -g @anthropic-ai/claude-code`. It installs the same native binary through `@anthropic-ai/claude-code-darwin-{arm64,x64}`.
  - Binary: `$(npm prefix -g)/bin/claude`. Often under nvm/volta/fnm folders.
- **Windows equivalents:** native `%USERPROFILE%\.local\bin\claude.exe`, or WinGet `Anthropic.ClaudeCode`.

**PATH for a GUI app** (general macOS behaviour, not from the Claude docs)
- Apps started from Finder or the Dock get a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so a plain PATH lookup fails.
- Suggested lookup order:
  1. A path the user set in the app's settings.
  2. `$SHELL -l -i -c 'command -v claude'`, with a timeout. Also take the PATH it prints and use it for the terminal sessions.
  3. Check these in order: `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.npm-global/bin/claude`, `~/.volta/bin/claude`, `~/.bun/bin/claude`.
- When starting `claude` through the terminal library (portable-pty), pass the login-shell PATH, `HOME`, `USER` (the Keychain account), `LANG`, and `CLAUDE_CONFIG_DIR` for the chosen profile.
- The Windows app clears `CLAUDECODE`, `CLAUDE_PID` and `CLAUDE_CODE_*` before launching (ClaudeManager.ps1:11). Do the same on macOS.
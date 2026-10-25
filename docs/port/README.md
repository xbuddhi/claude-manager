# Port plan (from the mapping run, 2026-10-25)

- `plan.json` - tech-lead plan: feature_list (spec per feature), architecture, foundation_tasks, work_packages, release_checklist, risks
- `features.json` - raw inventory of the Windows app (ClaudeManager.ps1 + MacUI.cs), 156 items with source refs
- `findings.json` - production-readiness audit of the prototype, 103 findings
- `research.md` - how Claude Code stores credentials, live markers and transcripts on macOS vs Windows

## Decisions by the owner (override the plan)
- Identity: bundle identifier `com.xbuddhi.claudemanager`, publisher `xbuddhi`, product name "Claude Manager".
- No GitHub repo yet: build the release workflow and updater fully, but keep the updater disabled (no endpoint/pubkey active) until a repo and signing keys exist. Nothing is pushed or published.

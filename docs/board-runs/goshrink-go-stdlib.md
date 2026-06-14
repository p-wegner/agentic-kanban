# Board run — goshrink (URL shortener + analytics, Go stdlib) — 2026-06-14

First **Go** rung of the "drive agents through projects" ladder, run concurrently with a sibling Rust drive (both on codex). Goal: exercise the per-stack feedback harness on a Go stack, hands-off, operator changing **board settings only**. This doc covers SETUP + KICKOFF (subagent); the multi-hour drive + close-out are the parent session's resident watch.

## App
**goshrink** — URL shortener + link-analytics HTTP service, Go standard library only (no external deps, so `go.mod` is not a hot file). Substantial unit-testable domain logic: base62 encode/decode + random short-code generation, token-bucket rate limiting, click analytics, expiry/TTL, deterministic QR matrix, URL validation/normalization. HTTP surface: `/health` + `/openapi.json` route-listing smoke surface, plus 15 feature endpoints.

## Setup
- Project `C:\andrena\goshrink`, board proj `2bb1db09-39d8-425b-a6ce-45001a2a6794`, defaultBranch `master`.
- **18 tickets, wide fan-out:** epic meta #1 (no-auto-start, In Progress) + 15 feature tickets #2–#16 (all unblocked from the shell) + integration #17 (deps #2–#16) + retro #18 (deps #17). Board confirmed 15 `isBlocked==false`, #17/#18 `isBlocked==true` — a wide middle, not a chain.
- Seeded atomically: meta created first, then `POST /api/issues/batch` + `/dependencies/batch` (autodrive temporarily OFF so create-then-edge had no race; re-enabled after edges verified).

## Hot files — all pre-resolved at scaffold
- **Route registration**: a self-registration registry (`internal/router`) — each feature `init()`s its own routes via `router.Register`; no central route table to edit.
- **`cmd/server/main.go`**: the one shared file. Pre-wired with one commented import line per feature, tagged by name; each ticket uncomments ONLY its own line.
- **Tests**: each feature owns its `_test.go` in its OWN package; the smoke test (`cmd/server/smoke_test.go`) reflects routes from the registry, so no shared test file is appended to.
- **Shared link data**: a complete `internal/links` repository (`links.Default`, Create/Get/All/Delete/Update/IncrementClicks) — features CALL it, never edit it. Shared `model.Link`, `internal/shortid` (base62), `internal/store` (generic) round out the scaffold-owned core.
- Scaffold committed up-front and `go build ./... && go test ./...` GREEN locally before seeding (7 packages, ~20 table-driven tests).

## Provider — codex, isolated per-project
Operator directive: codex default for ALL board agents. Set `codex:default` **only** in `board_strategy_<PID>` providerPolicies (`mode:fill`) → `selectProviderFromStrategy` makes every builder + review launch on codex. Global `provider=claude`/`claude_profile=anth`/`default_model=""` left untouched (the agentic-kanban Conductor depends on them). WIP kept modest (`activeAgentsTarget`/`maxNewStartsPerCycle=3`, `backlogFloor:0`) to share codex with the sibling Rust drive. Verify gate `verify_script_<PID> = "go build ./... && go test ./..."`. Codex reads `AGENTS.md` (committed): self-verify with go build+test, commit when green, file-scope discipline, NO Playwright/screenshots.

## Friction / escalation — the keystone fix
**Every codex launch failed silently with `STALE_SAFETY_POLICY`.** Project registration places the board's safety harness (`.claude/hooks/smart-hooks-runner.js` etc.) into the **main checkout working tree** but the auto-appended `.gitignore` line `.claude/` kept it **untracked** → fresh worktrees never received it → `workspaceLaunchPreflight`'s `findStaleSafetyFiles` saw main-has / worktree-lacks, flagged stale, and its reconcile (`git checkout <base> -- <file>`) failed because the file isn't in any branch. Result: the monitor created 16 worktrees but launched **zero** sessions (silent — no `error` on the workspace rows; provider resolved to codex correctly, so it masqueraded as a provider problem).

**Fix:** narrow goshrink's `.gitignore` to ignore only `.claude/` *runtime-state* files and **commit the safety harness** (`.claude/hooks/*`, `.claude/settings.json`) to master (commit `8b91471c`) so worktrees get identical copies. After a clean slate (deleted the 16 debris workspaces + pruned worktrees + reset statuses), a fresh `POST /api/workspaces` returned 201 `provider=codex` with **no** STALE error, and a live codex session attached (status=running, real token output: the agent correctly described adding the `shorten` package and "uncomment only the ticket's side-effect import"). A forced monitor cycle then cascaded to exactly 3 live codex builders (#2/#8/#9) — WIP=3 honored.

This is a **generalizable new-project blocker**: any project whose registration gitignores `.claude/` will silently fail every worktree launch until the safety harness is committed. Worth a board-side fix (commit the harness at register time, or have the preflight reconcile pull from the main checkout working tree rather than the branch).

## State at handoff
- Scaffold green on master (`8b91471c`); 18 tickets seeded; codex providerPolicy + autodrive + auto_merge/auto_review/auto_merge_in_review + monitor strategy all ON; globals unchanged.
- 3 live codex builders cascading (#2 shorten, #8 list, #9 delete). Meta #1 In Progress (contract).
- Residual cosmetic board drift from the cleanup churn (a dozen issues show In Progress without a workspace) — autodrive/reconciler will normalize as the wave drains; not a blocker.

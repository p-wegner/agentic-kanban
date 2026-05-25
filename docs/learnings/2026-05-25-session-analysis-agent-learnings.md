# Agent Session Analysis — Key Learnings
**Date:** 2026-05-25  
**Corpus:** 248 Claude Code sessions across 44 issues + main project dirs  
**Method:** 6 parallel subagents analyzing high-retry, E2E, refactoring, feature, large-session, and cross-cutting stat clusters

---

## Overall Statistics

| Metric | Value |
|--------|-------|
| Total sessions | 248 |
| Sessions with agent response | 243 (98%) |
| Dead (no response, tiny startup fail) | 5 (2%) |
| `end_turn` (normal completion) | 167 (67%) |
| `tool_use` (interrupted mid-tool) | 57 (23%) |
| `stop_sequence` (rate limit / auth) | 19 (8%) |
| `max_tokens` | 0 |
| Sessions > 1MB | 32 — **30/32 ended `end_turn`** (large = success, not failure) |
| Burst days | 2026-05-22 (80 sessions, rework day); 2026-05-23 (89 sessions, healthy) |

---

## Critical Problems

### 1. Post-Completion Churn — the #1 cause of "high retry count"

High retry counts are almost never caused by a hard coding problem. They're caused by agents relaunching on already-complete branches and re-proving completion.

- **#214** (24 sessions): feature complete at session 3. Sessions 4–24 were re-validation, flaky test re-runs, merge-conflict handling.
- **#210** (29 sessions): completed early, then 11+ sessions just rediscovered/re-verified it.
- **#116** (20 sessions): 18/20 ended `tool_use` — agent kept trying to start servers and run Playwright to verify a badge that was already merged.

**Root cause:** No handoff state. Each relaunch starts blind, re-reads context, and re-proves the previous session's conclusion.

**Fix:** Persist structured handoff state in the worktree on completion: commit hash, changed files, passing test commands, known unrelated failures. Board should detect "already In Review + clean commit" and route to merge flow, not implementation flow.

---

### 2. Environment Instability Dominates UI/E2E Work

On complex UI or E2E sessions, agents spend more time on environment issues than actual feature work.

Recurring blockers found:

| Issue | Root cause |
|---|---|
| `localhost` → `::1` (IPv6) on Windows | Broke Playwright in #182, #179 and others. Fix: always use `127.0.0.1`. |
| Worktree `.git` file missing | #332 spent major effort before failing on this |
| Wrong worktree ports | Agents used default 3001/5173 instead of offset ports from `$KANBAN_SERVER_PORT` |
| Windows OOM killing vite build | Exit code `4294967295` (`STATUS_PROCESS_KILLED`) |
| `claude.exe` ENOENT | Main project sessions blocked on missing binary path |
| Migration failures / empty DB | #116 repeatedly hit "only migrations table exists" |

**Fix:** Add a preflight block to every worktree launch: verify `.git` exists, `KANBAN_SERVER_PORT`/`KANBAN_CLIENT_PORT` set, `127.0.0.1` used, DB migrated. Fail fast with a clear error message.

---

### 3. `tool_use` Stop = Died Waiting on Long-Running Tasks

23% of all sessions ended with `stop_reason: tool_use`. This does **not** mean the agent made a bad tool call — it means the session was **interrupted while waiting** for a long-running background task (tests, builds, server startup).

- #116: 18/20 sessions ended this way
- Refactoring sessions: frequently interrupted while waiting for `pnpm test` or `vite build`

**Fix:**
- Use bounded task timeouts with explicit fallback behavior.
- Run targeted tests (only files touched) instead of the full suite.
- Avoid long-polling patterns; prefer async notification.

---

### 4. Plan Mode Trap in Autonomous Sessions

Agents entering plan mode in fully autonomous (non-interactive) sessions produce **zero code** — the turn ends cleanly (`end_turn`) with only a plan document, which looks like "success" but delivers nothing.

- **#328**: wrote a plan file, no code. Led directly to a follow-up bug-fix ticket (#330).
- Multiple sessions asked clarifying questions or requested plan review, ending the turn with no implementation.

**Fix:** For board-launched sessions, suppress plan-mode entry or auto-approve `ExitPlanMode`. CLAUDE.md already documents this but agents still trigger it. Consider making it a hook-enforced constraint.

---

### 5. E2E Test Quality Anti-Patterns

Recurring anti-patterns written by agents across E2E sessions:

| Anti-pattern | Found in |
|---|---|
| `projects[0]` instead of `/api/preferences/active-project` | #176, #184 (fixed explicitly in #184) |
| `page.waitForTimeout(1000)` fixed sleeps | #173 |
| `localhost` in test base URL | #182 (fixed explicitly) |
| Broad/brittle locators (`text=`, class chains, `.first()`) | #184, #173 |
| Overclaiming success under broken runtime | **#197** — claimed passing with empty `node_modules` + `STATUS_ACCESS_VIOLATION` crash |
| `mock_agent` guard missing in test environment | #182 review (real Claude launched in test env) |
| Treating skipped/not-run tests as "pass enough" | #184 reruns |
| Visual verification substituting for automated tests | #173, #200 |

**Fix:** Add explicit E2E anti-pattern list to CLAUDE.md. Require agents to confirm Playwright binary works and `pnpm test:e2e` exits 0 before claiming tests pass.

---

### 6. Runaway Meta-Sessions (No Circuit Breaker)

Board-monitor and orchestration sessions can spiral out of control:
- One "board state?" query hit **434 assistant turns / 274 tool calls** before hitting a 429 rate limit.
- #331 hit hard 429 quota mid-task on provider `glm-5.1`.

**Fix:** Add a rate-limit budget + checkpoint to the board-monitor skill. Auto-stop after N tool calls or T minutes. Add rate-limit retry delay to agent spawning logic.

---

## Moderate Issues

### 7. Pre-Existing Test Failures Poison Confidence

`git.service.test.ts` timeouts and flakes appear in sessions for issues that don't touch git-service at all. Agents correctly identify them as pre-existing but still burn retries re-proving this every session.

**Fix:** Document known flaky suites in CLAUDE.md with explicit "do not rerun" instructions. Consider skipping them in worktree test runs automatically.

---

### 8. Stateless Relaunches — Agents Re-Read Everything from Scratch

Every session starts by re-reading CLAUDE.md, exploring the codebase, re-discovering what the previous session did.

- #214 had agents "start by reading `session.manager.ts`" 15+ times across 24 sessions.

**Fix:** Write a structured `HANDOFF.md` (or `last-session.json`) in the worktree after each session with: what was done, what passed, what's left, known flake patterns.

---

### 9. Band-Aid Patching Before Root Cause

Bug-fix sessions often start with symptom patches and only reach root cause on the 2nd or 3rd pass.

- **#304**: 3 sessions — first two applied progressively broader cleanup filters; third found the actual control-flow bug (cleanup code placed after early-return statements).
- **#13**: speculation under tool failure, no conclusive diagnosis.

**Fix:** Bug ticket template should require "root cause + proof + exact changed files" as the Definition of Done. First session that doesn't prove root cause should produce a follow-up diagnostic ticket, not a code patch.

---

### 10. Scope Creep on Refactoring Tasks

Refactoring tasks drift into adjacent concerns:
- #341 drifted into DB/migration debugging
- #343 and #344 stalled on dev-server startup for visual verification
- #342 made it through by staying focused despite being 1149KB

**Fix:** Refactoring tickets should explicitly state "do not fix unrelated issues encountered; document them as new tickets."

---

## What Agents Do Well

1. **Precise root-cause diagnosis on UI flakes** — #178 identified the exact `group-hover:pointer-events-auto` overlay mechanism intercepting clicks; #179 found the async `e.target.checked` checkbox capture bug.
2. **Honest verification** — #237 and #227 correctly concluded "feature already implemented" without inventing unnecessary work.
3. **Recovery from context compaction** — #179 (405 tools, 1 compaction) still completed successfully; large sessions ≠ lost sessions.
4. **Concrete UI features with clear acceptance criteria** — #134, #255, #256, #257 completed cleanly with visual verification.
5. **Strong bug-fix diagnosis when tools work** — #330 reconstructed the full `ExitPlanMode` permission denial chain and fixed it correctly in one session.
6. **Good E2E patterns when applied** — API-driven fixtures, `afterAll` cleanup arrays, `Date.now()` suffixes, route mocking for slow paths, retry loops for workspace setup.

---

## Prioritized Action Items

### P0 — Fix immediately

1. **Canonicalize `127.0.0.1`** in all E2E tests, agent instructions, and CLAUDE.md (confirmed: Windows `localhost` → `::1` breaks Playwright).
2. **Preflight checklist for worktree launch**: `.git` file exists, DB migrated, ports set in env, `127.0.0.1` used.
3. **Suppress plan-mode in board-launched sessions** or auto-approve `ExitPlanMode`.

### P1 — High value

4. **Structured handoff state**: After each session, write commit hash + passing commands + known flakes to worktree. Show in board UI.
5. **Stop relaunching implementation after "In Review + clean commit"**: Route to merge/review workflow only.
6. **Rate-limit circuit breaker** in board-monitor skill (max N tool calls or T minutes).
7. **Targeted test runs** for refactoring: only run test files covering changed paths, not full suite.

### P2 — Quality improvements

8. **E2E anti-pattern list in CLAUDE.md**: `projects[0]`, fixed sleeps, brittle locators, claiming success under broken runtime, treating skips as passing.
9. **Document known flaky suites** (`git.service.test.ts`) as "do not rerun unless touching git-service."
10. **Bug ticket template**: require root cause + proof as Definition of Done.
11. **Refactoring ticket template**: add "document unrelated issues, don't fix them."
12. **Session analytics**: filter out `/clear`, health-check probes (`CODEX_OK`), and main-dir monitor sessions from retry counts and success rate metrics.

---

## Session Corpus

- **Worktree issues analyzed**: #6, #13, #15, #30, #116, #133, #134, #158, #169, #173, #176, #178, #179, #182, #184, #196, #197, #200, #210, #214, #215, #227, #237, #243, #251, #252, #253, #254, #255, #256, #257, #258, #299, #304, #328, #330, #331, #332, #339, #340, #341, #342, #343, #344
- **Total sessions**: 248
- **Analysis method**: 6 parallel Claude Sonnet subagents, each reading session tails, first prompts, and stop reasons via PowerShell JSONL parsing

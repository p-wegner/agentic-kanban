# Adversarial Architecture Review — 2026-07-07

Method: code-metrics (90-day window, 1912 files) targeted six parallel adversarial deep-dives
(config/prefs, agent-CLI seam, frontend topology, server orchestration, persistence integrity,
SSOT-claims/test architecture). Every CRITICAL/HIGH claim below was either **VERIFIED** directly
(I re-ran the check myself) or is labeled **REPORTED** (agent evidence with file:line, spot-checked
but not exhaustively re-run).

Ticket drafts for filing are at the bottom (`## Ticket drafts`), including a `create-batch` JSON.
**Not yet filed** — pending DB migration from the other machine.

---

## Meta-finding: the codebase heals symptoms with machinery, not causes

This repo is overwhelmingly agent-written (author dominance 81–97% on the hot files) and its
agents are good at *adding a guard for the last incident*: divergence-guard tests, polarity
ratchets, a cohesion baseline that grandfathers 6 god-modules, ~10 startup reconcilers, boot-time
FK table rebuilds, a force-refresh whitelist for stale skill prompts. Each of these is the fossil
of an incident where **a value/invariant had two owners and they disagreed**. The machinery works —
but every layer of it is itself a new consumer of the drifting value, and the underlying
two-owner designs are all still in place. The highest-leverage theme across every finding:
**collapse to one owner (one write path, one parser, one gate, one client factory, one transition
table) and delete the reconciliation machinery**, rather than adding the next ratchet.

Metrics headline: hottest file `client/src/routes/BoardPage.tsx` at **719 commits/90d**;
`routes/projects.ts` 400; `server-start.ts` 375; `types/api.ts` 122; 124 refactor-first files;
max CC 46. The churn concentrates exactly where every feature is forced to pass through a shared
hub — which, for a board whose whole point is *parallel* agents, means structural merge conflicts.

---

## 1. Architecture decisions that truly limit future implementation

### 1.1 Workflow progression = best-effort side-effect chains + reconciler durability layer (server)
There is no persisted state machine for workspace/issue status. `setWorkspaceStatus`
(`packages/shared/src/lib/workspace-status.ts:80-119`) enforces exactly one rule (terminal
closed+merged); any of ~24 calling files may write any status from anywhere; issue transitions are
the same shape (`shared/src/lib/workflow-engine/status-transition.ts` is a guarded setter, not a
machine). Durability is retrofitted by ~10 interval scanners wired in `server-start.ts:171-213`
(stranded-review, zombie-fix-session, plan-mode, ancestor-branch, done-unmerged,
terminal-workspace-reaper, completion-state, drive-completion, project-completion,
auto-merge-orchestrator) — each repairs an invariant a non-transactional write path fails to
maintain, each is itself a status writer growing the concurrency surface (#953's guard exists
because reconcilers themselves re-stranded issues). Restart mid-orchestration loses workflow
position by design; recovery is forensic re-inference (`done-unmerged-invariant-scanner`'s
MAX_COMMITS_BEHIND=20 heuristic; the #590 mass-reopen incident was this guessing wrong).
**Every new workflow feature currently costs: handler in exit-workflow + reconciler + guard test.**
(REPORTED, with the gate-fork and skip-flag parts VERIFIED below.)

### 1.2 Merge is a policy with ≥6 independently-gated trigger paths (server) — VERIFIED core
One git executor (`runMergeCore`) and one lock, but the *decision + quality gates* are
re-implemented per path:
1. manual/MCP/HTTP → `runPreMergeGate` (`workspace-merge.service.ts:282-300`);
2. monitor auto-merge → `skipPreMergeGate: true` (`monitor-workspace-actions.ts:80`, VERIFIED) on a
   "gate ran earlier this cycle" argument — an acknowledged TOCTOU window (#943);
3. review-exit → an **inline copy** of the verify/smoke gates with a literal *"keep the two in
   sync"* comment (`exit-workflow.ts:561-565`, VERIFIED);
4. `autoMerge` foundational-sync path (`merge-workflow.ts:176`) → `runMergeCore` directly, **no gate**;
5. done-unmerged scanner → `mergeBranch` under lock, no gate;
6. batch reconciler agent → path 1 driven by an LLM.
Any future gate (e.g. security scan) must be threaded through ≥4 sites or silently not apply.
#821/#930/#943 were all patches to this same hole-matrix.

### 1.3 Frontend: the god-object was relocated, not dissolved (client)
The #905/#958 container/presenter split produced a **95-field `BoardPageViewModel`**
(`components/BoardPageView.tsx:82-178`) and a BoardPage that still wires 26 hooks via shared
mutable refs. Three state regimes coexist mid-migration (prop-bag useState, zustand stores,
react-query), so every feature = new hook field → ViewModel field → destructure → prop — the
719-commit churn signature. `Layout.tsx` is a 27-prop pass-through funnel (234 commits).
An untyped `window` CustomEvent bus (`lib/useBoardEvents.ts:15-21`) exists explicitly to bypass
the prop pipeline — the escape hatch proving the pipeline is too painful. (REPORTED; triple-state
copy VERIFIED below.)

### 1.4 Manual dual registries + hand-authored wire contract (cross-stack)
No contract mechanism binds client to server: `lib/api.ts:19` is `res.json() as Promise<T>`
(zero runtime validation; zod is installed but **zero** routes use `zValidator`), the contract is
the hand-authored 964-line flat `shared/src/types/api.ts` (**122 commits/90d** — the repo's #4
churn), and every feature must also edit two manual registries: `routes/index.ts` (server mounts)
and `lib/viewRegistry.tsx` + the 35-branch view switch in `BoardSecondaryViews.tsx` (client).
That is the structural cause of the BoardToolbar↔routes/index.ts temporal coupling the metrics
flagged. For parallel agents, `types/api.ts` and `api.test.ts` (2960 lines, 104 tests, 80
commits/90d) are the two worst merge-conflict magnets in the repo. (VERIFIED sizes/churn; zod
non-use REPORTED.)

### 1.5 Composition-root churn: `server-start.ts` (375 commits) and `routes/projects.ts` (400)
`server-start.ts` lines 171–234 are a pure registration list — every reconciler/loop/feature adds
an import + start call + cleanup push; no `{start,stop}` plugin registry. `routes/projects.ts` is
the grab-bag namespace: ~10 genuinely-project endpoints out of 35+ (board-health, dependency-waves,
sprint-capacity, risk digest, throughput, stack-profile…) because "everything is project-scoped".
Low bug risk, high conflict tax. (REPORTED, churn VERIFIED by metrics.)

---

## 2. Risky dependencies

### 2.1 Internal fork: builtin skill prompts exist in TWO arrays, DB copies stale by design — VERIFIED
`packages/server/src/db/seed.ts:86-625` (`DEFAULT_SKILLS`, 20 entries incl. tag/type seeds) and
`packages/server/src/builtin-skills.ts` (`BUILTIN_SKILLS`, 17) define **12 overlapping skill
names** (VERIFIED by name-list diff). The seed loop inserts-if-missing (`seed.ts:636`) with no
version/hash, plus a hand-picked force-refresh whitelist (`seed.ts:671-710`). Consequences:
(a) the `butler` prompt has already diverged between the two files and the `builtin-skills.ts`
copy is dead code (REPORTED: 4,850 vs 6,936 chars); (b) any skill not on the whitelist — including
`code-review`, the prompt driving all auto-reviews — **silently stays stale in existing DBs**
after code edits. Agents "improving" prompts commit no-ops.

### 2.2 External seam: inner-field wire-format drift parses as silent zeros, then cascades — VERIFIED
Unknown-event telemetry fires only on unknown top-level `type`
(`shared/src/lib/agent-stream-parser.ts:111-121`); zod drift schemas cover only the Claude/Codex
`result` usage block. Inside events it's duck-typing with default-to-empty:
`agent-stream/claude.ts:84` (usage rename → contextTokens silently 0, VERIFIED), `:89`
(content-shape change → no assistantText), `:16` (session_id rename → resume chain silently
breaks). The cascade: no assistantText → `hadSubstantiveOutput` false
(`session-lifecycle.ts:692-694`) → real completed runs classified as **launch failures**,
workspace idled, profile health poisoned — the exact "0 tokens" class re-fixed field-by-field in
#976/#994. CLI version guard exists but is warn-only even below min
(`agent-cli-version.service.ts:268-285`), `maxKnown` is a hand-decayed constant, and the Pi
`--approve` poison-flag knowledge is prose-only (nothing strips it from `agentArgs`;
`pi-provider.ts:82-84` splices blind). (REPORTED except where marked.)

### 2.3 Internal fork: two DB bootstraps with already-divergent semantics + FK-off writers — VERIFIED
`server/src/db/pragmas.ts:17-32` vs `mcp-server/src/db.ts:30-62`: same 7-pragma list, two copies,
different error semantics (server aborts batch on first failure and catches the whole batch;
MCP continues per-pragma). A pragma added to one side fails no test on the other. Meanwhile
`scripts/seed-example-session.ts:18` still ships a bare `createClient` that **INSERTs
workspaces/sessions with FK OFF** (VERIFIED) — the exact #987 disease — plus a stray
`query62.mjs` debug script with string-interpolated SQL. MCP runs no FK-violation sweep or action
alignment (server-only guards).

### 2.4 Offline transcript parsing forked ≥3 ways (REPORTED)
Live-stream parsing is genuinely unified behind `agent-stream/*` (client included — the old
client fork is fixed). But persisted-format knowledge is not:
`butler-transcripts.service.ts:51-136` and `mcp-server/src/tools/session-history.ts:106-135` each
hand-parse `~/.claude/projects/*.jsonl` with hardcoded Claude shapes (the MCP one silently
misreports codex/copilot/pi sessions), and offline summaries sniff provider per-event with
"unrecognized → copilot" as catch-all (`agent-stream/detect-provider.ts:55-66`) because
`session_messages` rows never recorded their provider. The butler's Codex path additionally
hand-rolls its own spawn/parse lifecycle inside `butler-sdk.service.ts:397-520` using the
**unobserved** parser — re-opening on that path the hole #898 closed on the main one.

---

## 3. Most concerning code (latent bugs)

### 3.1 CRITICAL: `PRAGMA foreign_keys` inside migrations is a no-op under the transactional runner — VERIFIED
`manual-migrate.ts:132` wraps every migration file in `client.transaction("write")`; SQLite
documents `PRAGMA foreign_keys` as a no-op while a transaction is open. Migrations
`0010_session_messages_cascade.sql`, `0039_nullable_default_branch.sql`,
`0096_test_runs_session_fk.sql` toggle it and depend on it. 0039 does `DROP TABLE projects` —
with FK actually ON, any **populated** pre-0039 DB migrating under the current runner aborts
there; 0010/0096 abort if orphaned rows exist. Masked because fresh DBs replay on empty tables.
Bonus: `migrate-fresh.mjs:8` runs the same files on a bare client (FK OFF) — same migration,
different semantics per entry point.

### 3.2 HIGH: reattached sessions lose exit semantics — recorded as clean success — VERIFIED
The reattach PID-poll emits `exitCode: null` (`agent.service.ts:743`) and `notifyExternalExit`
records `String(exitCode ?? 0)` → completed/"0" (`session-lifecycle.ts:950`), bypassing the whole
exit state machine (no usage-limit detection, no launch-failure classification, no HANDOFF).
Detached-and-survive is the *default* for Claude/Pi on Windows, so a crash/quota-exhaustion after
any `tsx watch` restart is logged as success.

### 3.3 HIGH: MCP `set_preference` bypasses the divergence guard and objective regeneration — VERIFIED
`mcp-server/src/tools/set-preference.ts:93-97` is a raw upsert — no
`checkProviderDivergenceGuard`, no `updateStrategyObjectives` (both live only in
`preference.service.ts:140-146`). `set_preference provider=codex` recreates exactly the drift
that #903 claims made impossible ("the prefs can no longer drift" — server/CLAUDE.md, oversold);
writing `board_strategy_<id>` via MCP leaves Conductor (objective.md reader) and monitor (pref
reader) on different tunables. Related structural point (REPORTED): the guard compares against a
quota-free provider resolution while real launches are quota-aware
(`project-runtime-config.service.ts:188` vs `strategy-objective.service.ts:516-525`) — a static
pref can never consistently mirror a time-varying selection.

### 3.4 HIGH: monitor scheduling still gated by legacy `board_autodrive_*`, not Start Mode — VERIFIED
`monitor-setup.ts:30-42`: `monitorShouldRun` = `auto_monitor || board_autodrive_* regex`;
`resolveStartPolicy` is consulted only *inside* a cycle. So (a) `start_mode=monitor` with autodrive
unset and `auto_monitor` off (force-disabled every boot) → the "supported hands-off driver"
silently never schedules; (b) `start_mode=manual` with a stale `board_autodrive=true` → cycles
still relaunch/nudge/auto-merge that project — the "true kill-switch" only kills starts. Coherence
depends on every writer using `buildDriveRuntimePreferencePatch`; nothing enforces that.

### 3.5 HIGH: board state in three synchronized copies + hand-rolled transport beside react-query — VERIFIED
`hooks/useBoardRefetch.ts:59-115`: own ETag cache, monotonic sequence guard, debounce, in-flight
dedupe, raw fetch — then writes `setColumns` + `columnsRef.current` + `queryClient.setQueryData`
(lines 112-115). Every mutation handler must decide which copies to touch; the "F6 stale data"
reconcile effect exists solely to patch drift between copies. A whole staleness-bug class is
structural.

### 3.6 MEDIUM: project-delete cascade uses `LIKE '%_${projectId}'` with unescaped `_` wildcard — VERIFIED
`shared/src/lib/cascade-delete.ts:242,247`: `_` matches ANY character. Benign for UUIDs, but the
live DB contains legacy numeric project ids (`fk-violations.ts:7-9` cites `project_id='3276'`) —
`%_276` also matches keys of project `3276` when deleting project `276`-style ids. The
completeness assertion uses the same wildcard so it cannot see its own overreach. Prefs/runtime
state have no FK at all — integrity by string convention.

### 3.7 MEDIUM: two delete mechanisms + bypass sites (REPORTED)
Schema declares `onDelete: cascade`; `cascade-delete.ts` re-deletes everything explicitly anyway;
raw bypasses exist (`workflow-fork.repository.ts:232-234` raw `delete(workspaces)` — sessions FK
has NO onDelete → FK-fail or orphan; `monitor-backlog.ts:41` swallows its FK failure). Boot-time
FK "alignment" rebuilds live tables with a hand-rolled DDL comma-splitter
(`fk-actions-repair.ts:65-103`) and is deliberately non-fatal — repair machinery mutating
production schema every boot.

### 3.8 MEDIUM: in-memory orchestration state as wiring currency (REPORTED)
Session role (builder/review/fix) = process-lifetime `Set<string>`s threaded from
`exit-workflow.ts:226` through server-start into monitor/reconcilers/routes; the #950 DB fallback
patched one consumer, the Sets remain the currency. `reconcilerAttempts` cap and merge dedupe maps
are memory-only — a crash-looping server launches unbounded reconciler agents.

---

## 4. What's genuinely good (and which claims are oversold)

- **git SSOT claim HOLDS** (VERIFIED by agent): server/mcp git services are literal one-line
  re-exports; shared git-service is a 27-line facade over 9 cohesive submodules; the `git-exec`
  AST gate is real and self-testing. Caveat: the gate scans only `*.ts` under `src/` — the
  scaffold `.js` hook scripts and `e2e/global-setup.ts` escape by accident, not by allowlist.
- **The client parser fork is fixed** — client delegates to shared `agent-stream/*`. Metrics
  co-change signals for git-service were the *migration itself*, not current coupling.
- **Provider adapter registry is real** (parity-tested; adding provider #5 is cheap); SDK deps
  exact-pinned; process management (detach/drain/#909) careful and centralized.
- **Migrations hygiene mostly clean** (journal monotonic, no dup numbers; fresh-apply drift test
  compensates for the abandoned snapshot chain). Test DBs are per-suite, not a shared fixture.
- **Oversold claims to correct in docs**: "prefs can no longer drift" (server/CLAUDE.md — MCP side
  door); "hand-maintained migration list" in root CLAUDE.md (it's journal-derived now);
  "Start Mode is the single control for auto-start" (scheduling is still autodrive-gated).

## 5. Priorities (highest leverage first)

1. **One preference write path** (server-side `setPreferenceChecked` used by HTTP/CLI/MCP/internal;
   guard + objective regen inside it) — kills findings 3.3, 2.1-adjacent drift class at the root.
2. **One merge gate owner** (gate decision inside `runMergeCore`/`doMerge` with an explicit
   gate-result token instead of `skipPreMergeGate`) — kills 1.2.
3. **Fix the migration-runner FK no-op** (run FK-toggling migrations outside the tx, or rewrite
   0010/0039/0096 to not need the pragma) before the next legacy-DB migration is attempted — 3.1.
4. **Transition table for workspace/issue status** inside `setWorkspaceStatus`/
   `transitionIssueStatus`; then retire reconcilers one at a time — 1.1.
5. **Zod schemas at the agent-stream edge** (per-provider event schemas, unknown-*field* telemetry,
   fail-loud resume-id absence) + fix external-exit code recording — 2.2, 3.2.
6. **Merge the two skill-prompt arrays** into one module with a content-hash refresh — 2.1.
7. **Client: finish ONE state regime** (react-query as owner, delete useBoardRefetch's triple
   write) before any new views — 1.3, 3.5.

---

## Ticket drafts

All titles prefixed `[arch-review]`; tag `no-auto-start` recommended so the monitor doesn't
launch them before triage. Severity in brackets.

1. **[arch-review][CRITICAL] Migration runner makes PRAGMA foreign_keys a no-op — 0010/0039/0096 broken for populated legacy DBs**
   `manual-migrate.ts:132` wraps each migration in a write tx; SQLite ignores the pragma inside a
   tx; 0039 drops `projects` (parent of everything). `migrate-fresh.mjs` runs the same SQL with
   FK OFF — divergent semantics per entry point. Action: execute FK-toggling migrations outside
   the transaction (or rewrite them pragma-free) + add a populated-DB migration test.
2. **[arch-review][HIGH] MCP set_preference bypasses provider-divergence guard and objective.md regeneration**
   `mcp-server/src/tools/set-preference.ts:93-97` raw upsert. Action: route all pref writes
   through one shared checked write path (guard + `updateStrategyObjectives` inside).
3. **[arch-review][HIGH] Monitor scheduling ignores Start Mode — legacy board_autodrive_* still decides if cycles run**
   `monitor-setup.ts:30-42`. `start_mode=monitor` can silently no-op; `start_mode=manual` doesn't
   stop relaunch/auto-merge if a stale autodrive flag exists. Action: make `resolveStartPolicy`
   the scheduling input; derive autodrive from it, not beside it.
4. **[arch-review][HIGH] External/reattach session exit recorded as success "0", bypassing exit state machine**
   `agent.service.ts:743` + `session-lifecycle.ts:950`. Action: route `notifyExternalExit`
   through `classifySessionExit` with an explicit `unknown` exit-code state.
5. **[arch-review][HIGH] Agent-stream inner-field drift parses as silent zeros → launch-failure misclassification cascade**
   `agent-stream/claude.ts:16,84,89`; telemetry only covers top-level type. Action: per-provider
   zod event schemas at the parser edge + unknown-field counters + fail-loud missing session_id.
6. **[arch-review][HIGH] Merge quality-gate policy duplicated across ≥6 trigger paths (one confessed "keep in sync" fork)**
   `exit-workflow.ts:561-565`, `monitor-workspace-actions.ts:80` skip-flag, ungated
   `merge-workflow.ts:176` + done-unmerged path. Action: move gate decision into the single merge
   executor; replace `skipPreMergeGate` with a passed gate-result token; delete the inline copy.
7. **[arch-review][HIGH] Builtin skill prompts forked across seed.ts and builtin-skills.ts; DB copies stale by default**
   12 overlapping names; butler already diverged; force-refresh whitelist covers a minority.
   Action: single skill-source module + content-hash column; refresh unedited builtins on boot.
8. **[arch-review][HIGH] Board state held in 3 synchronized copies with a hand-rolled fetch engine beside react-query**
   `useBoardRefetch.ts:59-115`, `useBoardDataController.ts:20-66`. Action: make react-query the
   owner (ETag via query fn, WS invalidation), delete columns/columnsRef mirrors.
9. **[arch-review][MEDIUM] No transition table for workspace/issue status — reconciler accretion is the durability layer**
   `workspace-status.ts:80-119` (one terminal rule), ~24 caller files, ~10 reconcilers in
   `server-start.ts:171-213`. Action: explicit legal-transition table + role-scoped write API;
   retire reconcilers incrementally.
10. **[arch-review][MEDIUM] Collapse the two DB bootstraps + kill remaining FK-off writer scripts**
    `server/src/db/pragmas.ts` vs `mcp-server/src/db.ts` fork (divergent error semantics);
    `seed-example-session.ts:18` bare client INSERTs; `query62.mjs`. Action: one
    `createClientWithPragmas` factory in shared, used by server, MCP, scripts; delete strays.
11. **[arch-review][MEDIUM] cascade-delete LIKE '%_<id>' unescaped wildcard + prefs have no FK**
    `cascade-delete.ts:242,247`. Action: escape `_`/use exact dynamic-key enumeration; consider a
    project_id column (or key-registry-driven delete) for prefs/runtime_state.
12. **[arch-review][MEDIUM] Bullseye policy parsed by two different parsers with different semantics; quota gating server-only**
    `strategy-objective.service.ts:111-131` vs `shared/lib/strategy-policy.ts:83-109`; MCP
    start_workspace + butler skip quota. Action: one shared parser + one quota-aware selector for
    all entry points.
13. **[arch-review][MEDIUM] Offline transcript parsing forked 3× and provider sniffing defaults to copilot**
    `butler-transcripts.service.ts:51-136`, `mcp-server/tools/session-history.ts:106-135`,
    `detect-provider.ts:55-66`. Action: shared transcript-reader on agent-stream parsers; store
    provider on session_messages rows.
14. **[arch-review][MEDIUM] Butler Codex path hand-rolls a second subprocess lifecycle with unobserved parsing**
    `butler-sdk.service.ts:397-520`. Action: reuse agent.service launch/parse (or at least
    `parseStreamEventObserved` + hang watchdog).
15. **[arch-review][MEDIUM] types/api.ts (964 lines, 122 commits/90d) + api.test.ts (2960 lines) are the parallel-agent merge magnets**
    Action: split both by resource/feature; adopt zod-inferred (or ts-rest/OpenAPI) route contracts
    so DTO drift fails loud; `lib/api.ts:19` casts today.
16. **[arch-review][LOW] server-start.ts registration list → {start,stop} plugin registry; routes/projects.ts grab-bag → feature-module mounts**
    Conflict-tax reduction for the two 375/400-commit hubs.
17. **[arch-review][LOW] git-exec single-spawn gate: exempt-by-decision, not by file-extension accident**
    Add scaffold `.js` scripts + e2e/global-setup.ts to the explicit allowlist; scan `.js` too.
18. **[arch-review][LOW] Docs drift: retire oversold SSOT claims**
    Root CLAUDE.md migration-list claim; server/CLAUDE.md "prefs can no longer drift";
    Start Mode "single control" wording. Agents steer by these files.
19. **[arch-review][LOW] Pi --approve poison flag: encode in code, not prose**
    `pi-provider.ts:82-84` splices agentArgs blind; strip/deny known-bad flags per provider.
20. **[arch-review][LOW] CLI version guard: make below-min actionable**
    `agent-cli-version.service.ts:268-285` warn-only console line; surface as board health
    event/launch-blocking pref instead of stdout.

### create-batch JSON (for later filing)

Save as `arch-review-tickets.json`, then from the MAIN checkout:
`pnpm cli -- issue create-batch arch-review-tickets.json`

```json
{
  "issues": [
    { "title": "[arch-review][CRITICAL] Migration runner makes PRAGMA foreign_keys a no-op — 0010/0039/0096 broken for populated legacy DBs", "priority": "critical", "issueType": "bug", "tags": ["no-auto-start", "arch-review"], "description": "manual-migrate.ts:132 wraps each migration file in client.transaction(\"write\"); SQLite ignores PRAGMA foreign_keys inside an open transaction. Migrations 0010/0039/0096 toggle it and depend on it; 0039 drops `projects` (parent of nearly every table), so a POPULATED pre-0039 DB aborts mid-migration under the current runner. migrate-fresh.mjs:8 runs the same files on a bare client (FK OFF) — divergent semantics per entry point. Action: execute FK-toggling migrations outside the transaction (or rewrite them pragma-free) and add a populated-DB migration test. VERIFIED 2026-07-07 adversarial arch review (docs/adversarial-arch-review-2026-07-07.md §3.1)." },
    { "title": "[arch-review][HIGH] MCP set_preference bypasses provider-divergence guard and objective.md regeneration", "priority": "high", "issueType": "bug", "tags": ["no-auto-start", "arch-review"], "description": "mcp-server/src/tools/set-preference.ts:93-97 does a raw drizzle upsert — never calls checkProviderDivergenceGuard or updateStrategyObjectives (both only in preference.service.ts:140-146). set_preference provider=codex recreates the #903 drift; board_strategy_<id> writes leave Conductor (objective.md) and monitor (prefs) on different tunables. Action: one shared checked pref-write path used by HTTP/CLI/MCP/internal, guard + objective regen inside. VERIFIED (review §3.3)." },
    { "title": "[arch-review][HIGH] Monitor scheduling ignores Start Mode — legacy board_autodrive_* still decides whether cycles run", "priority": "high", "issueType": "bug", "tags": ["no-auto-start", "arch-review"], "description": "monitor-setup.ts:30-42: monitorShouldRun = auto_monitor || board_autodrive_* regex; resolveStartPolicy only consulted inside a cycle. start_mode=monitor can silently never schedule (auto_monitor force-disabled each boot); start_mode=manual does NOT stop relaunch/nudge/auto-merge when a stale autodrive flag exists — the kill-switch only kills starts. Action: make resolveStartPolicy the scheduling input; derive autodrive from it. VERIFIED (review §3.4)." },
    { "title": "[arch-review][HIGH] External/reattach session exit recorded as clean success \"0\", bypassing the exit state machine", "priority": "high", "issueType": "bug", "tags": ["no-auto-start", "arch-review"], "description": "agent.service.ts:743 reattach PID-poll emits exitCode null; session-lifecycle.ts:950 notifyExternalExit records String(exitCode ?? 0) as completed — no usage-limit detection, no launch-failure classification, no HANDOFF. Detached-survive is the DEFAULT for Claude/Pi on Windows, so any crash/quota-exhaustion after a tsx-watch restart logs as success. Action: route external exits through classifySessionExit with an explicit unknown-exit-code state. VERIFIED (review §3.2)." },
    { "title": "[arch-review][HIGH] Agent-stream inner-field drift parses as silent zeros → launch-failure misclassification cascade", "priority": "high", "issueType": "bug", "tags": ["no-auto-start", "arch-review"], "description": "Unknown-event telemetry fires only on unknown top-level type (agent-stream-parser.ts:111-121); inside events it's duck-typing with default-to-empty: claude.ts:84 (usage rename → contextTokens 0), :89 (content shape → no assistantText), :16 (session_id rename → resume silently breaks). Cascade: no assistantText → hadSubstantiveOutput false (session-lifecycle.ts:692-694) → real runs classified launch-failure, profile health poisoned (#976/#994 class). Action: per-provider zod event schemas at the parser edge + unknown-FIELD telemetry + fail-loud missing session_id. VERIFIED core (review §2.2)." },
    { "title": "[arch-review][HIGH] Merge quality-gate policy duplicated across ≥6 trigger paths (one confessed \"keep the two in sync\" fork)", "priority": "high", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "Gate variants: runPreMergeGate (workspace-merge.service.ts:282-300); monitor skipPreMergeGate:true (monitor-workspace-actions.ts:80, TOCTOU acknowledged #943); inline verify/smoke copy in exit-workflow.ts:551-721 with literal 'keep the two in sync' at :561-565; autoMerge (merge-workflow.ts:176) and done-unmerged scanner merge with NO gate; batch reconciler re-enters path 1. Any future gate must be threaded through ≥4 sites. Action: gate decision inside the single merge executor; replace skipPreMergeGate with a gate-result token; delete the inline copy. VERIFIED (review §1.2)." },
    { "title": "[arch-review][HIGH] Builtin skill prompts forked across seed.ts and builtin-skills.ts; DB copies stale by default", "priority": "high", "issueType": "bug", "tags": ["no-auto-start", "arch-review"], "description": "DEFAULT_SKILLS (db/seed.ts:86-625) and BUILTIN_SKILLS (builtin-skills.ts) define 12 overlapping skill names (VERIFIED); seed inserts-if-missing (seed.ts:636) with no version/hash + hand-picked force-refresh whitelist (:671-710). butler already diverged (builtin-skills.ts copy is dead code); code-review not whitelisted → prompt edits silently never reach existing DBs. Action: single skill-source module + content-hash column; auto-refresh unedited builtins on boot. (review §2.1)." },
    { "title": "[arch-review][HIGH] Board state held in three synchronized copies with a hand-rolled fetch engine beside react-query", "priority": "high", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "useBoardRefetch.ts:59-115: own ETag cache, sequence guard, debounce, dedupe, raw fetch, then writes setColumns + columnsRef.current + queryClient.setQueryData (:112-115); useBoardDataController.ts:20-66 syncs the copies. Every mutation must pick which copies to touch; the F6 stale-data reconcile effect patches the resulting drift. Action: react-query becomes the single owner (ETag in query fn, WS invalidation); delete the mirrors. VERIFIED (review §3.5)." },
    { "title": "[arch-review][MEDIUM] Introduce a legal-transition table for workspace/issue status; retire reconcilers incrementally", "priority": "medium", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "setWorkspaceStatus (workspace-status.ts:80-119) enforces only the terminal rule; ~24 files write status; ~10 startup reconcilers (server-start.ts:171-213) repair invariants the write paths don't maintain and are themselves status writers (#953). Restart loses workflow position; recovery is forensic guessing (#590 incident). Action: explicit transition table + role-scoped write API inside the two setters; then retire reconcilers one at a time. (review §1.1)." },
    { "title": "[arch-review][MEDIUM] Collapse the two DB bootstraps into one shared client factory; kill remaining FK-off writer scripts", "priority": "medium", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "server/src/db/pragmas.ts:17-32 vs mcp-server/src/db.ts:30-62: same 7 pragmas, two copies, DIVERGENT error semantics (server aborts batch+catches all; MCP per-pragma continues). seed-example-session.ts:18 bare createClient INSERTs with FK OFF (the #987 disease, VERIFIED); query62.mjs stray debug script. MCP runs no FK sweep/alignment. Action: one createClientWithPragmas factory in shared used everywhere; delete stray scripts; share the FK startup guards. (review §2.3)." },
    { "title": "[arch-review][MEDIUM] cascade-delete uses LIKE '%_<projectId>' with unescaped _ wildcard; prefs have no FK", "priority": "medium", "issueType": "bug", "tags": ["no-auto-start", "arch-review"], "description": "cascade-delete.ts:242,247: `_` is a single-char LIKE wildcard; live DBs contain legacy numeric project ids (fk-violations.ts:7-9), so deleting one project can delete another's prefs/runtime_state; the completeness assertion (:274) uses the same wildcard and can't see the overreach. Action: escape the underscore / enumerate exact dynamic keys from the key registry; longer-term give prefs/runtime_state a project_id column. VERIFIED (review §3.6)." },
    { "title": "[arch-review][MEDIUM] Bullseye policy parsed by two parsers with different semantics; quota gating server-only", "priority": "medium", "issueType": "bug", "tags": ["no-auto-start", "arch-review"], "description": "strategy-objective.service.ts:111-131 (filters entries lacking id/provider) vs shared strategy-policy.ts:83-109 (keeps + synthesizes) feed different consumers — same blob selects different providers per entry door; isPolicyBlockedByQuota only on the server path (MCP start_workspace + butler skip it). Also: divergence guard compares against a quota-FREE resolution while launches are quota-aware (project-runtime-config.service.ts:188) — a static pref mirror of a time-varying value is structurally guaranteed to drift. Action: one shared parser + one quota-aware selector. (review §3.3/§2 REPORTED)." },
    { "title": "[arch-review][MEDIUM] Offline transcript parsing forked 3× — provider sniffing defaults to copilot", "priority": "medium", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "butler-transcripts.service.ts:51-136 and mcp-server/tools/session-history.ts:106-135 hand-parse ~/.claude JSONL with hardcoded Claude shapes (MCP one misreports codex/copilot/pi); detect-provider.ts:55-66 catch-all 'unrecognized → copilot' because session_messages never stored provider. Action: shared transcript reader built on agent-stream parsers; persist provider per session_messages row. (review §2.4)." },
    { "title": "[arch-review][MEDIUM] Butler Codex path hand-rolls a second subprocess lifecycle with unobserved parsing", "priority": "medium", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "butler-sdk.service.ts:397-520: own spawn wiring, line-splitting, stderr accumulation, stale-resume recovery — duplicating agent.service.launch (no hang watchdog, no drain-on-exit) and calling the UNOBSERVED provider.parseStreamEvent (:448,:495), re-opening the #898 silent-swallow hole on this path. Action: reuse the main launch/parse stack, or minimally parseStreamEventObserved + watchdog. (review §2.4)." },
    { "title": "[arch-review][MEDIUM] Split types/api.ts and api.test.ts — the two worst parallel-agent merge magnets — and validate route payloads", "priority": "medium", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "shared/types/api.ts: 964 lines, 75 types, 122 commits/90d, hand-authored, zero runtime enforcement (lib/api.ts:19 res.json() as T; zod installed, zero zValidator routes). api.test.ts: 2960 lines/104 tests/80 commits, append-target explaining the test temporal-coupling cluster. Action: split both by resource; adopt zod-inferred route contracts so DTO drift fails loud. (review §1.4)." },
    { "title": "[arch-review][LOW] server-start.ts registration list → {start,stop} plugin registry; routes/projects.ts → feature-module mounts", "priority": "low", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "server-start.ts:171-234 pure registration (375 commits/90d); routes/projects.ts 35+ endpoints, ~10 genuinely project CRUD (400 commits/90d). Conflict-tax reduction for the two hottest server hubs. (review §1.5)." },
    { "title": "[arch-review][LOW] git-exec single-spawn gate: make escapes explicit allowlist decisions", "priority": "low", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "git-exec-single-spawn.test.ts scans only *.ts under packages/*/src (:71,:305). scaffold/smart-hooks-runner.js:27,206, vital-file-guard.js:43, e2e/global-setup.ts:83 spawn git raw and escape by file-extension/location accident, not by decision. Action: scan .js too + add explicit justified allowlist entries. (review §4)." },
    { "title": "[arch-review][LOW] Docs drift: retire oversold SSOT claims in CLAUDE.md files", "priority": "low", "issueType": "chore", "tags": ["no-auto-start", "arch-review"], "description": "Root CLAUDE.md: 'add new migrations to helpers/migrations.ts or tests won't see new tables' — stale, list is journal-derived now. server/CLAUDE.md: 'the prefs can no longer drift' — false (MCP side door). 'Start Mode is the single control' — scheduling is still autodrive-gated. Agents steer by these files; stale claims misdirect the fleet. (review §4)." },
    { "title": "[arch-review][LOW] Encode Pi --approve poison-flag knowledge in code, not prose", "priority": "low", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "pi-provider.ts:82-84 splices agentArgs blind; the 'Pi 0.73.1 rejects --approve' knowledge lives only in comments/CLAUDE.md. Action: per-provider denied-flag list applied to agentArgs. (review §2.2)." },
    { "title": "[arch-review][LOW] CLI version guard: make below-min actionable instead of a console line", "priority": "low", "issueType": "task", "tags": ["no-auto-start", "arch-review"], "description": "agent-cli-version.service.ts:268-285 warn-only even below minSupported; maxKnown is a hand-decayed constant (last verified 2026-07-02). Action: surface as board health event / launch-gating pref; automate maxKnown refresh. (review §2.2)." }
  ]
}
```

# Coverage gaps — capability `workspaces`

Analyzed SHA `0a954ccd` · 26 behaviours · judged against the candidate workspace-touching test set only.
Status mix: **19 covered · 2 partial · 5 uncovered · 0 undocumented-implemented · 0 documented-missing.**
Capability score **0.76**. Systematically weak dimensions: **state-transition**, **error**. `permission` is near-N/A (single-user local-first, no RBAC).

---

## 0. Lead findings — regression-prone & unverified (read first)

These are the textbook P0/P1s: the suite has no guard exactly where the code is high-blast-radius and/or keeps changing.

- **`workspaces.cascade.post-merge-followups` — UNCOVERED, high-risk, prior regression.** The post-merge dependency cascade (autoStartFollowups) is the engine of hands-off autonomy, and it *already regressed once* (leaked past a `manual` Start-Mode kill-switch). No candidate test asserts it. `merge-cascade.test.ts` / `auto-start-followup-setting.test.ts` exist outside the candidate set and are **not** credited here. Testable at the API level.
- **`workspaces.lifecycle.reattach-survives-reload` — UNCOVERED, high-risk, high-churn host.** Whole-fleet survival across a server hot-reload (reattach live-PID sessions, reap dead-PID, don't die on SIGTERM). Implemented in `agent.service.ts` (churn 91, the highest-churn workspace service file); prior regression (ancestor-reconciler reaped fresh workspaces on hot-reload). Exec cost is high but the blast radius justifies it.
- **`workspaces.plan.approve-reject` — UNCOVERED, recent regression (AK-924).** The plan-mode gate that stops an agent writing code before human approval has no end-to-end route test. Host file `workspace-actions.ts` is the single highest-churn workspace route (churn 180). AK-924 (plan-mode strand) is a fresh failure in this exact area.

---

## 1. Covered (19) — outcome asserted across risk-relevant dimensions

`create.launch`, `create.missing-issue`, `create.launch-failure-persists`, `create.plan-mode-default`, `preview.dry-run`, `list.scoped`, `turn.followup`, `diff.etag-cached`, `merge.land`, `merge.conflict`, `merge.not-approved`, `merge.dirty-main-blocked`, `merge.already-merged-reconcile`, `fix-and-merge.resolve`, `delete.cascade`, `lifecycle.exit-classification`, `direct.no-worktree`, `provision.symlink-traversal-guard`, `hygiene.stale-worktree-cleanup`.

The merge family is the strongest-covered area: `workspace-merge-service.test.ts` (115 assertions) + `merge-error-reporting.test.ts` + the lifecycle-transition suites assert clean-merge, conflict-409, not-approved, dirty-main, already-merged reconcile, dedup, and the silent-merge-loss guard (#820). Create + lifecycle classification (#678) are likewise solidly asserted.

## 2. Partial (2) — touched but a dimension is unasserted

| behaviour | covered dims | missing | why |
|---|---|---|---|
| `create.one-direct-per-issue` | boundary, capability | **error** | The block (no second direct ws row) is asserted, but the exact HTTP failure contract (4xx code vs error-in-201-body) is not — flagged as an open unknown in the behaviour model. |
| `stop.strand-recovery` | workflow, api | **state-transition** | Stop→idle reset is well covered; the **quarantine** sub-path (POST `/:id/quarantine` moves the issue *back to In Progress*) has no asserting test. The e2e `/stop` test is `touches-only` (asserts 200, not the idle reset). |

## 3. Uncovered (5) — behaviour exists, no candidate test exercises it

| behaviour | risk | missing dims | churn(90d) | note |
|---|---|---|---|---|
| `cascade.post-merge-followups` | high | workflow, state-transition, capability | 14 | dependency-DAG auto-start; prior regression; testable via API. |
| `lifecycle.reattach-survives-reload` | high | state-transition, regression | 91 | restart survival; exec cost high. |
| `plan.approve-reject` | medium | workflow, state-transition, api, error | 180 | plan-gate HTTP surface incl. reject-no-feedback→400; AK-924. |
| `lifecycle.hang-watchdog` | medium | error, state-transition | 91 | 15-min zero-output kill; testable with fake timers. |
| `turn.missing-content` | low | error, api | 180 | POST `/:id/turn` without content → 400; cheap negative on a very-high-churn route file. |

## 4. Undocumented-implemented (0)

None found. The behaviour model was derived from code **and** domain docs, so every observed behaviour is documented. One latent inconsistency worth a regression-lock (not a new behaviour): the state model notes that **"active capacity"** (`ACTIVE_WORKSPACE_STATUSES` = active|fixing|reviewing|awaiting-plan-approval) and the **monitor auto-start gate** use *different* 3-state lists — the gate omits `awaiting-plan-approval`. The two vocabularies disagree by design today; if they should converge, pin it with a test before a refactor silently aligns them.

## 5. Documented-missing (0)

None found. No requirement/doc describes workspace behaviour the code fails to implement. (The model's `unknowns` are *un-probed* questions, not missing implementations — e.g. whether the plan-mode gate is reachable from the running UI, and whether a direct-workspace live merge truly no-ops. These are coverage gaps to *verify*, addressed in §3/`_priorities.md`, not contract violations.)

---

### Existing-test audit (leanness)
- No duplicates or low-value smoke tests flagged in the candidate set — the workspace suite is dense (assertion counts are high and outcome-bearing).
- `packages/e2e/tests/api/workspace-lifecycle.test.ts::POST /api/workspaces/:id/stop returns successfully` is `touches-only` (asserts HTTP success, not the idle reset). Not worth deleting, but it should not be counted as covering `stop.strand-recovery` — the service-level suite is what actually asserts that outcome.
- The two `lifecycle-status-transitions` / `lifecycle-transitions` files overlap heavily on the merge→Done path; not duplicates (different seams: route+issue-status vs MergeService internals) but candidates for consolidation if they drift.

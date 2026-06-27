# Verification priorities — capability `workspaces` (ROI-ranked gap backlog)

Analyzed SHA `0a954ccd`. ROI = (business_impact × regression_value) / (exec_cost + maint_cost), each factor 1–5; bands set by intent.
**Cut line: this list runs through P4.** P5 regression-locks are not emitted except the one inline note below. 8 gaps emitted; all open gaps from `_gaps.md` are represented.

---

### [P0 · ROI 4.0] workspaces.cascade.post-merge-followups — assert dependents auto-start when their blockers all reach Done
- capability: workspaces · dimensions to add: workflow, state-transition, capability
- actor: monitor · preconditions: a merged workspace; a dependent issue whose every blocker is now Done; project has a defaultBranch; no in-flight workspace on the dependent; Start Mode permits auto-start
- entry point: event `autoStartFollowups()` fired by POST /api/workspaces/:id/merge (followup-workspace.service.ts:27)
- observable outcome: a new workspace row + launched agent appear for each unblocked dependent; a `workspace_merged` event is emitted only AFTER the agent launches; nothing starts when defaultBranch is absent, the dependent already has a workspace, or Start Mode = manual
- suggested assertions: after merge, GET issue-scoped workspaces for the dependent returns a new non-closed row; cascade is SKIPPED (no new row) when project defaultBranch is null; cascade is SKIPPED when a non-closed workspace already exists on the dependent; (if mockable) Start Mode=manual produces no cascade
- factors: impact 5 (engine of hands-off autonomy) · regression 4 (churn 14 + prior leak past manual kill-switch) · exec 3 (merge + dep-graph fixture; mock agent launch) · maint 2 → ROI (5×4)/(3+2)=4.0
- evidence: followup-workspace.service.ts:27/44/55 ; behaviour workspaces.cascade.post-merge-followups (confidence medium); decision 008 Start Mode
- existing partial: none in candidate set. merge-cascade.test.ts / auto-start-followup-setting.test.ts exist OUTSIDE the candidate set — verify whether they already cover this before authoring (may downgrade to a dimension top-up).

### [P1 · ROI 4.0] workspaces.plan.approve-reject — assert the plan-mode approval gate end-to-end
- capability: workspaces · dimensions to add: workflow, state-transition, api, error
- actor: operator · preconditions: a workspace launched in plan mode with a pendingPlanPath written
- entry point: GET /api/workspaces/:id/plan ; POST /:id/implement-plan ; POST /:id/reject-plan (workspace-actions.ts:75/88)
- observable outcome: GET returns the pending plan; implement-plan → 201 and the workspace transitions awaiting-plan-approval → active (implementation starts, no code written before approval); reject-plan WITH feedback → 201 and re-planning runs; reject WITHOUT feedback → 400
- suggested assertions: GET body contains the plan text; POST implement-plan returns 201 and workspace status flips to active; POST reject-plan with feedback returns 201; POST reject-plan with no feedback returns 400 {error}; assert no implementation session starts while status is awaiting-plan-approval
- factors: impact 4 (cost gate — prevents burning tokens on a misunderstanding) · regression 4 (workspace-actions.ts churn 180; AK-924 plan-mode strand) · exec 2 (route-level, mockable) · maint 2 → ROI (4×4)/(2+2)=4.0
- evidence: workspace-actions.ts:75/88, schema/workspaces.ts:24 ; behaviour workspaces.plan.approve-reject (confidence medium); MEMORY: ak-924 plan-mode strand fix
- existing partial: plan-mode.service.test.ts covers service logic but is OUTSIDE the candidate set and does not exercise the HTTP gate.

### [P1 · ROI 3.6] workspaces.lifecycle.reattach-survives-reload — assert agents survive a server hot-reload
- capability: workspaces · dimensions to add: state-transition, regression
- actor: monitor · preconditions: an agent spawned detached + unref'd; the server process restarts (tsx hot-reload / SIGTERM)
- entry point: startup reattach in agent.service.ts:509
- observable outcome: sessions with a live PID are reattached and the output watcher resumes from the last byte offset; dead-PID sessions are marked stopped and their workspaces reset to idle; agents are NOT killed on SIGTERM (only on SIGINT)
- suggested assertions: with a fake live PID, after reattach the session stays running and the watcher offset advances from the prior byte position; with a dead PID, the session is stopped and the workspace status is idle; a SIGTERM does not terminate the tracked child
- factors: impact 5 (whole-fleet survival; an outage if broken) · regression 5 (agent.service.ts churn 91; prior hot-reload reaper regression) · exec 4 (must simulate restart + PID liveness) · maint 3 (couples to process internals) → ROI (5×5)/(4+3)=3.6
- evidence: agent.service.ts:509, packages/server/CLAUDE.md (Agent process survival) ; behaviour workspaces.lifecycle.reattach-survives-reload (confidence medium)
- existing partial: none. agent.service.test.ts is outside the candidate set; confirm it does not already assert reattach before authoring.

### [P4 · ROI 3.0] workspaces.turn.missing-content — assert POST /:id/turn with no content is rejected
- capability: workspaces · dimensions to add: error, api
- actor: operator · preconditions: an existing workspace
- entry point: POST /api/workspaces/:id/turn (workspace-actions.ts:55)
- observable outcome: request returns 400 {error:'content is required'}; no agent session is started
- suggested assertions: status 400; response body error message; session count for the workspace unchanged
- factors: impact 2 (input-validation guard) · regression 3 (host file workspace-actions.ts churn 180) · exec 1 (single request) · maint 1 → ROI (2×3)/(1+1)=3.0
- evidence: workspace-actions.ts:55 ; error_state workspaces.turn.missing-content (confidence high)
- existing partial: none — no candidate test asserts the missing-content path; cheap, high-leverage on a very-high-churn route file.

### [P2 · ROI 2.25] workspaces.stop.strand-recovery (quarantine) — assert quarantine moves the issue back to In Progress
- capability: workspaces · dimensions to add: state-transition
- actor: operator · preconditions: a workspace with a running or stranded session
- entry point: POST /api/workspaces/:id/quarantine (workspace-actions.ts:69)
- observable outcome: the running session is stopped, the workspace resets to idle, AND the issue moves back to In Progress (distinct from plain /stop, which leaves issue status untouched)
- suggested assertions: workspace status idle after quarantine; issue status is In Progress after quarantine; quarantine is a safe no-op when nothing is running
- factors: impact 3 · regression 3 (workspace-actions.ts churn 180) · exec 2 · maint 2 → ROI (3×3)/(2+2)=2.25
- evidence: workspace-actions.ts:62/69, workspace-lifecycle-status-transitions.test.ts:962 ; behaviour workspaces.stop.strand-recovery (confidence high)
- existing partial: lifecycle-status-transitions asserts stop→idle but NOT the quarantine issue-status move; e2e /stop test is touches-only.

### [P2 · ROI 1.7] workspaces.lifecycle.hang-watchdog — assert a zero-output agent is killed after the watchdog interval
- capability: workspaces · dimensions to add: error, state-transition
- actor: agent-subprocess · preconditions: an agent running with no stdout/stderr for the watchdog interval (15 min)
- entry point: spawn-layer watchdog in agent.service.ts:34/248
- observable outcome: after the silent interval the agent process is killed and the session transitions to stopped/failed; the watchdog timer is reset on every output event (a chatty agent is never killed)
- suggested assertions: with fake timers, advancing past the interval with zero output kills the process and marks the session stopped/failed; emitting output before the interval resets the timer and the agent survives
- factors: impact 3 · regression 4 (agent.service.ts churn 91) · exec 4 (timer simulation, process-kill harness) · maint 3 → ROI (3×4)/(4+3)=1.7
- evidence: agent.service.ts:34/248 ; behaviour workspaces.lifecycle.hang-watchdog (confidence medium)
- existing partial: none in candidate set.

### [P3 · ROI 2.0] workspaces.create.one-direct-per-issue — pin the exact failure contract of the second-direct block
- capability: workspaces · dimensions to add: error
- actor: operator · preconditions: an existing non-closed direct workspace on the same issue
- entry point: POST /api/workspaces with isDirect=true (workspace-create.service.ts:378)
- observable outcome: the create is refused with a determinate contract (assert the precise shape — 4xx status code vs error-in-201-body — and lock it); no second direct workspace row appears
- suggested assertions: exact HTTP status of the refusal; error body/code; the issue still has exactly one non-closed direct workspace
- factors: impact 2 · regression 2 · exec 1 · maint 1 → ROI (2×2)/(1+1)=2.0
- evidence: workspace-create.service.ts:378, workspace-create-harden.test.ts:788 ; behaviour workspaces.create.one-direct-per-issue (confidence high) — closes the model's open unknown about the exact status code
- existing partial: workspace-create-harden asserts the block but not the precise HTTP contract.

### [P4 · ROI 2.0] workspaces.plan.approve-reject (negative) — assert reject-plan without feedback returns 400
- capability: workspaces · dimensions to add: error
- actor: operator · preconditions: a plan-mode workspace awaiting approval
- entry point: POST /api/workspaces/:id/reject-plan (workspace-actions.ts:91)
- observable outcome: a reject with no feedback body → 400; no re-planning session starts
- suggested assertions: status 400; error message; no new session created
- factors: impact 2 · regression 3 (workspace-actions.ts churn 180) · exec 1 · maint 1 → ROI (2×3)/(1+1)=3.0 (banded P4 as a negative path; fold into the P1 plan-gate test as one assertion rather than a separate file)
- evidence: workspace-actions.ts:91, error_state workspaces.plan.reject-no-feedback ; behaviour workspaces.plan.approve-reject
- note: this is the negative half of the P1 plan-gate gap — author it inside the same test file, not standalone.

---

### Inline P5 candidate (regression-lock, not authored above)
`state-vocabulary disagreement`: `ACTIVE_WORKSPACE_STATUSES` (active|fixing|reviewing|awaiting-plan-approval) vs the monitor auto-start gate's 3-state list that omits `awaiting-plan-approval`. If these are meant to converge, add a P5 lock asserting the intended set before a refactor silently aligns them. Not emitted as a gap row because today's divergence is by-design and already partly asserted by `workspace-activity-state.test.ts`.

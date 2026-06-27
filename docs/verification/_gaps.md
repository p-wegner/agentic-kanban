# Coverage gaps — all capabilities

Every behaviour that is not `covered`, grouped by capability. `partial` = touched/some-dimensions; `uncovered` = no asserting test. Lead with the five-way taxonomy counts.

**Totals:** 232 covered · 26 partial · 15 uncovered · 0 undocumented-implemented · 0 documented-missing.

## workspaces (20/26 covered)

- **[uncovered]** `workspaces.turn.missing-content` _(missing: error, api)_ — No candidate test asserts POST /:id/turn with no content → 400 {error:'content is required'}. The turn route lives in workspace-actions.ts (churn 180, the single highest-churn workspace route file) — a refactor could silently drop the guard
- **[uncovered]** `workspaces.plan.approve-reject` _(missing: workflow, state-transition, api, error)_ — No candidate test exercises the plan-gate HTTP surface: GET /:id/plan, POST /:id/implement-plan (201 → starts implementation), POST /:id/reject-plan with feedback (201 → re-plans), reject without feedback → 400. plan-mode.service.test.ts ex
- **[uncovered]** `workspaces.lifecycle.hang-watchdog` _(missing: error, state-transition)_ — No candidate test asserts that a zero-output-for-15-min agent is killed by the spawn-layer watchdog (reset on each output event). Implemented in agent.service.ts (churn 91 — the highest-churn workspace service file). agent.service.test.ts i
- **[uncovered]** `workspaces.lifecycle.reattach-survives-reload` _(missing: state-transition, regression)_ — No candidate test asserts the restart-reattach invariant: live-PID sessions reattach + resume the output watcher from the last byte offset, dead-PID sessions are marked stopped and their workspaces reset to idle, agents are not killed on SI
- **[partial]** `workspaces.create.one-direct-per-issue` _(missing: error)_ — The block (no second direct workspace row) is asserted, but the exact HTTP failure contract (4xx code vs error-in-201-body) is never asserted — the behaviour model flags this as an open unknown. A consumer relying on a specific status code 
- **[partial]** `workspaces.stop.strand-recovery` _(missing: state-transition)_ — Stop→idle reset is well covered. The quarantine sub-behaviour (POST /:id/quarantine additionally moves the issue BACK to In Progress) has no asserting test in the candidate set — the issue-status side of the transition is unverified.

## monitor-orchestration (15/18 covered)

- **[uncovered]** `monitor-orchestration.conductor.lifecycle` _(missing: state-transition, error, regression)_ — conductor-control.service (start no-op-if-alive, detached spawn, tree-kill + PowerShell backstop, stop-marker) has NO test. project-conductor.service.test.ts covers config parsing only; orchestrator-monitor covers the read-only liveness sid
- **[uncovered]** `monitor-orchestration.guard.re-entrancy-and-maintenance` _(missing: state-transition, regression, config)_ — No test asserts the re-entrancy guard (a mid-cycle trigger runs exactly one more pass, never two concurrent cycles) nor the maintenance-window suppression. startup-timers-hmr covers timer-handle recreation only, not the in-cycle guard. This
- **[uncovered]** `monitor-orchestration.butler.llm-cycle` _(missing: workflow, observability, config)_ — runMonitorButlerCycle has no behavioural test (only startup-timers-hmr asserts its scheduler timer is recreated/cleared). The single-active-project limitation and board_health_events logging are unasserted. Lower priority — off by default a

## codemods (7/9 covered)

- **[uncovered]** `codemods.preview.limit-guard` _(missing: boundary, error-handling, config)_ — The >100-TS-file blast-radius guard and its overrideLimit override path are never exercised. This is the module's scale safety interlock and has no test at either the block or the override-and-proceed edge.
- **[partial]** `codemods.get.byid` _(missing: api)_ — Only the 404-unknown-id branch is asserted. The success path (GET /:id returning an existing saved codemod's body) is never directly fetched/asserted -- the save test verifies presence via the list endpoint, not via GET /:id.

## mcp-server (16/20 covered)

- **[uncovered]** `mcp-server.fire.webhook` _(missing: error, config, risk)_ — No MCP test fires the outbound webhook on a status change, nor asserts the loopback-only egress validation (outbound-webhook.ts:44) that is the one SSRF boundary against a malicious outbound_webhook_url_<projectId> pref. Security-relevant a
- **[uncovered]** `mcp-server.resilience.stay-up` _(missing: error, risk, regression)_ — The async-rejection-swallow / stdout-purity resilience policy (index.ts:236,246) — a stray rejection must not drop the stdio connection or corrupt the JSON-RPC stream — has no test. High blast radius (a crash makes every board op fail for t
- **[partial]** `mcp-server.orient.context` _(missing: boundary)_ — activeWorkspaces count is asserted with a single project; the suspected cross-project bleed (count not scoped by projectId, get-context.ts:35) is never asserted in a multi-project board.
- **[partial]** `mcp-server.launch.workspace` _(missing: api)_ — relaunch's WORKSPACE_NOT_IDLE and missing/closed errors are asserted; the actual delegation to REST /launch and its passthrough result are not. launch_workspace success path untested.

## board-ui (19/24 covered)

- **[uncovered]** `board-ui.move.archiveConfirm` _(missing: workflow, error-handling, state-transition, risk)_ — No e2e moves a ticket WITH a live workspace into Done/Cancelled to exercise the confirm dialog (block on cancel, commit on confirm). ai-reviewed-column tests move issues to terminal statuses but without a live workspace, so the gate never f
- **[uncovered]** `board-ui.move.dependencyPreview` _(missing: workflow, feature)_ — No candidate test advances/closes a ticket with dependents to assert the dependency-impact preview is shown before commit.
- **[partial]** `board-ui.realtime.reflectServerChange` _(missing: concurrency)_ — The 'status changes via API' e2e asserts the SERVER board reflects the move, not that the UI relocated the card (touches-only for the UI outcome). The agent-cascade coalescing/seq-guard behaviour (poll+WS overlap, out-of-order discard) is u
- **[partial]** `board-ui.wip.visualLimit` _(missing: feature)_ — The classifier logic (incl. boundary coercion of zero/garbage) is fully unit-tested, but the user-visible outcome — the column header rendering its red 'over' tint — is asserted by no test. The visual policy itself is unverified.
- **[partial]** `board-ui.shortcuts.keyboardNav` _(missing: accessibility)_ — The pure cursor-target arithmetic is fully unit-tested, but no e2e drives arrow/vim keys against the rendered board to assert the focused card actually moves (the keyboard-operability a11y outcome). The unit test would pass even if the keyd

## workflow-engine (12/16 covered)

- **[partial]** `workflow-engine.autoroute.condition` _(missing: boundary)_ — single-fire (auto Fix) and zero-fire (specify-a-target) are asserted, but the 'multiple edges fired -> refuse ambiguous' branch (transitions.ts:111) is never exercised
- **[partial]** `workflow-engine.evaluate.condition` _(missing: boundary)_ — core fire/block/manual verdicts asserted incl. one diff_touches glob, but glob boundary cases (single '*' not crossing '/', '?', '**/' collapse, unsupported brace/negation -> silent no-match) and agent_score/custom_js->manual are not assert
- **[partial]** `workflow-engine.validate.graph` _(missing: error-handling, boundary)_ — disconnect/dup-id/cycle/loop-exempt asserted, but the start-count!=1, missing-end, orphan-inbound, dead-end-outbound, and parallel fork<->join pairing rejection rules (graph-validation.ts:39-124) have no asserting test
- **[partial]** `workflow-engine.crud.template` _(missing: boundary)_ — full CRUD + builtin-immutability + import/export covered, but the empty-node draft create affordance (templates.ts:125 skips validation when nodes.length===0, resolving to a null start) is not asserted

## project-registration (14/17 covered)

- **[uncovered]** `project-registration.register.idempotent` _(missing: workflow, boundary, error-handling)_ — the UI test fulfills a MOCK 409; no server-level test proves registering the same git root (or a subdirectory of it) returns the existing project with created=false and no second row
- **[partial]** `project-registration.register.create` _(missing: workflow)_ — e2e asserts 201+{id,name,repoPath} but not the registration consequences as a journey (statuses seeded, branch non-null, skill attached) on the freshly-created project; UI test mocks the API so it only proves the modal flow
- **[partial]** `project-registration.seed.statuses` _(missing: workflow)_ — statuses are asserted on the long-lived E2E fixture project, not as a freshly-registered project's seeding consequence; the Backlog(-1) lane specifically is not asserted to exist

## persistence-schema (13/15 covered)

- **[uncovered]** `persistence-schema.resolve.db-location` _(missing: config, boundary, risk)_ — No test imports data-dir.ts. The existence-based resolution and the env-override precedence (DB_URL/AGENTIC_KANBAN_DIR -> local checkout -> ~/.agentic-kanban) are unasserted, despite being the mechanism behind the worktree-runs-against-a-di
- **[partial]** `persistence-schema.enforce.unique-issue-number` _(missing: error-handling)_ — Allocation logic (MAX+1, per-project scope) is asserted, but the DB-level uniqueness GUARANTEE — that a duplicate (project_id, issue_number) insert is rejected by idx_issues_project_id_issue_number — is never exercised. A concurrent double-

## agent-providers (14/16 covered)

- **[uncovered]** `agent-providers.login.oauthBootstrap` _(missing: workflow, error-handling, config)_ — No test exercises claude-login.service.ts / codex-login.service.ts. The load-bearing invariant (windowsHide:false so the OAuth callback survives) and the non-fatal-failure / returned-manual-command contract are entirely unverified. Hard to 
- **[partial]** `agent-providers.preflight.profileHealth` _(missing: state-transition)_ — failure-override-to-error and missing-config-error are asserted, but the version-probe-cached-once-per-(provider,command) optimization and the full ok→warning→error verdict folding across license-ring vs config-file auth validation are not 

## butler (16/19 covered)

- **[partial]** `butler.interrupt.inflight` _(missing: state-transition, concurrency, api)_ — the e2e test interrupts with NO active turn and only asserts res.ok(); the MCP test only checks request shape. The real behaviour — cancelling an IN-FLIGHT stream while keeping the session warm and accepting a subsequent turn — is never ass
- **[partial]** `butler.manage.definitions` _(missing: boundary)_ — CRUD happy paths asserted, but the two invariants — MAX_BUTLERS=4 cap refusing a 5th create, and 'default' being un-deletable — are never asserted
- **[partial]** `butler.history.access` _(missing: permission, boundary, api)_ — the sessions list is only checked for being an array; the 50-id cap is never asserted, and the SECURITY allowlist (a foreign project's session id must be refused on /sessions/:sid/messages) has no negative-path test

## agent-sessions (17/20 covered)

- **[partial]** `agent-sessions.persist.split-batch` _(missing: error-handling, concurrency)_ — stdout→file split and the 50-row batch flush are asserted; the 250ms time-based flush, the flush-on-exit guarantee, and the swallowed FK-constraint insert race (broadcast.ts:92) are not asserted
- **[partial]** `agent-sessions.read.rest` _(missing: api, boundary)_ — output ETag/304 and search are asserted; GET /api/sessions/:id/stats and /summary HTTP response shapes are not asserted at the endpoint layer (only the pure parser is). NOTE the documented boundary risk: search is LIKE over session_messages
- **[partial]** `agent-sessions.stream.live-subscribe` _(missing: concurrency, state-transition)_ — late-subscriber buffer replay is asserted; the buffer-free invariant (freed ONLY when last subscriber leaves AND session exited) and multi-subscriber behaviour are not exercised

## issues-board (18/19 covered)

- **[partial]** `issues-board.config.statuses` _(missing: error, state-transition)_ — the key invariant — DELETE of a status with linked issues must return 409 (project.repository.ts:224) so issues are never orphaned — has no asserting test in the candidate set; only GET/POST happy paths are exercised

## preferences-config (15/16 covered)

- **[partial]** `preferences-config.read.quota-usage` _(missing: api, error)_ — No test exercises the GET /api/preferences/quota-usage route or its 503 graceful-degradation path. The quota selection LOGIC (isPolicyBlockedByQuota) is well covered, but the HTTP endpoint contract (200 shape vs 503 on external outage) is u

## git-integration (17/18 covered)

- **[partial]** `git-integration.diff.working-tree` _(missing: boundary)_ — untracked-diff synthesis edge cases untested: binary/unreadable file (header-only) and trailing-newline off-by-one. Display-grade only; domain doc flags it as not apply-grade.

## review-merge (17/18 covered)

- **[partial]** `review-merge.foundational.sync-merge` _(missing: workflow)_ — isFoundationalBlocker eligibility classification is thoroughly covered, but the actual observable consequence — that an eligible foundational blocker is merged SYNCHRONOUSLY so a dependent isn't cut from an empty pre-merge base — is not ass


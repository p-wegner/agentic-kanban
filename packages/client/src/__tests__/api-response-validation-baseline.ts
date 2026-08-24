/**
 * Baseline for `api-response-validation-ratchet.test.ts` (#806, OUTBOUND half).
 *
 * A separate file so the grandfathered endpoints do not bury the rule they support — the
 * same split `fetch-in-effect-baseline.ts` uses for the same reason.
 *
 * 240 at the ratchet's first commit; 221 after #806's first outbound batch registered the tag
 * family, issue tags/dependencies, the workspace lifecycle actions and the project list;
 * **211** after batch 2 took the ten deepest READS — the board, the issue detail-bundle, the
 * workspace diff, and the status/repo/session/issue/workspace lists.
 *
 * The two batches are deliberately different in kind. Batch 1 registered MUTATIONS, whose
 * responses are mostly a handle: a wrong shape there is loud and immediate. Batch 2 is the
 * opposite end — responses the client destructures several levels down and then renders, where
 * a dropped field surfaces as an `undefined` inside a component and blanks a screen with
 * nothing pointing at the wire. Remaining entries should be picked the same way: by how badly
 * their failure mode hides, not alphabetically and not by how easy the schema is to write.
 *
 * **Entries are DELETED when fixed, never zeroed.** Register the endpoint in
 * `lib/apiResponseSchemas.ts` and remove its line here; the ratchet's staleness half fails on
 * an entry that no longer offends, so a leftover line is caught rather than tolerated.
 *
 * An entry may also leave because the client stopped calling that endpoint at all. That too
 * surfaces as stale — which is the point: this is a census of LIVE client calls, not a
 * historical record.
 *
 * A path that genuinely cannot be schematised (a streaming body, a file download, a shape
 * that varies by query parameter) keeps its line WITH a written reason above it. Zero is not
 * the goal; a stated, shrinking remainder is.
 */
export const UNVALIDATED_API_RESPONSES: readonly string[] = [
  // ── /api/agent-skills ──
  "DELETE /api/agent-skills/:param",
  "GET /api/agent-skills",
  "GET /api/agent-skills/install-status",
  "POST /api/agent-skills",
  "POST /api/agent-skills/:param/install",
  "POST /api/agent-skills/enhance",
  "PUT /api/agent-skills/:param",
  // ── /api/approvals ──
  "PUT /api/approvals/:param",
  // ── /api/butler-definitions ──
  "GET /api/butler-definitions",
  "PUT /api/butler-definitions/:param",
  // ── /api/codemods ──
  "POST /api/codemods",
  "POST /api/codemods/apply",
  "POST /api/codemods/preview",
  // ── /api/digest ──
  "GET /api/digest",
  // ── /api/failure-patterns ──
  "GET /api/failure-patterns/search",
  // ── /api/flaky-tests ──
  "DELETE /api/flaky-tests/pin",
  "GET /api/flaky-tests",
  "POST /api/flaky-tests/pin",
  // ── /api/focus ──
  "GET /api/focus",
  // ── /api/inbox ──
  "GET /api/inbox",
  // ── /api/insights ──
  "GET /api/insights",
  // ── /api/internal ──
  "GET /api/internal/monitor-status",
  "POST /api/internal/monitor-run",
  // ── /api/issues ──
  "DELETE /api/issues/:param/artifacts/:param",
  "DELETE /api/issues/:param/comments/:param",
  "DELETE /api/issues/:param/time-entries/:param",
  "GET /api/issues/:param/artifacts",
  "GET /api/issues/:param/dependencies",
  "GET /api/issues/:param/showdown",
  "GET /api/issues/:param/time-entries",
  "GET /api/issues/:param/workspaces",
  "GET /api/issues/cfd",
  "POST /api/issues/:param/analyze-touched-files",
  "POST /api/issues/:param/artifacts",
  "POST /api/issues/:param/decompose",
  "POST /api/issues/:param/decompose/confirm",
  "POST /api/issues/:param/preflight",
  "POST /api/issues/:param/showdown",
  "POST /api/issues/:param/time-entries",
  "POST /api/issues/ai-estimate",
  "POST /api/issues/analyze-dependencies",
  "POST /api/issues/archive-done",
  "POST /api/issues/contract-coupled",
  "POST /api/issues/dependencies/batch",
  "POST /api/issues/enhance",
  // ── /api/merge-queue ──
  "POST /api/merge-queue",
  "POST /api/merge-queue/preview/:param",
  // ── /api/metrics ──
  "GET /api/metrics/slow-requests",
  // ── /api/plugins ──
  "DELETE /api/plugins/:param",
  "GET /api/plugins",
  "GET /api/plugins/:param/loops/:param/artifact",
  "GET /api/plugins/:param/loops/:param/events",
  "GET /api/plugins/:param/scaffold",
  "GET /api/plugins/docs",
  "GET /api/plugins/marketplace",
  "POST /api/plugins",
  "POST /api/plugins/:param/:param",
  "POST /api/plugins/:param/disable",
  "POST /api/plugins/:param/enable",
  "POST /api/plugins/:param/loops/:param/:param",
  "POST /api/plugins/:param/loops/:param/advance",
  "POST /api/plugins/:param/loops/:param/gate/draft",
  "POST /api/plugins/:param/loops/:param/gate/resolve",
  "POST /api/plugins/:param/loops/:param/gate/summarize",
  "POST /api/plugins/:param/output-location",
  "POST /api/plugins/:param/scaffold",
  "POST /api/plugins/:param/scripts/:param/run",
  "POST /api/plugins/:param/update",
  "POST /api/plugins/:param/views/:param/start",
  "POST /api/plugins/:param/views/:param/stop",
  "POST /api/plugins/validate",
  "PUT /api/plugins/:param/loops/:param/artifact",
  "PUT /api/plugins/:param/scaffold",
  // ── /api/preferences ──
  "GET /api/preferences/active-project",
  "GET /api/preferences/agent-profiles/health",
  "GET /api/preferences/claude-profiles",
  "GET /api/preferences/codex-profiles",
  "GET /api/preferences/copilot-profiles",
  "GET /api/preferences/home-dir",
  "GET /api/preferences/mcp/health",
  "GET /api/preferences/pi-profiles",
  "GET /api/preferences/provider-divergence",
  "GET /api/preferences/quota-usage",
  "GET /api/preferences/settings",
  "GET /api/preferences/settings-bootstrap",
  "POST /api/preferences/agent-profiles/preflight",
  "POST /api/preferences/mcp/probe",
  "PUT /api/preferences/active-project",
  "PUT /api/preferences/settings",
  // ── /api/projects ──
  "DELETE /api/projects/:param/agent-questions/:param",
  "DELETE /api/projects/:param/repos/:param",
  "DELETE /api/projects/:param/scripts/:param",
  "DELETE /api/projects/:param/worktrees",
  "GET /api/projects/:param",
  "GET /api/projects/:param/agent-questions",
  "GET /api/projects/:param/board-health-events",
  "GET /api/projects/:param/board-health-events/:param",
  "GET /api/projects/:param/branches",
  "GET /api/projects/:param/butler/skill",
  "GET /api/projects/:param/butlers",
  "GET /api/projects/:param/conductor-schedule",
  "GET /api/projects/:param/dependency-waves",
  "GET /api/projects/:param/drive",
  "GET /api/projects/:param/drives",
  "GET /api/projects/:param/drives/:param/dashboard",
  "GET /api/projects/:param/file-contention",
  "GET /api/projects/:param/graph",
  "GET /api/projects/:param/graph/search",
  "GET /api/projects/:param/milestones",
  "GET /api/projects/:param/monitor-cycles",
  "GET /api/projects/:param/monitor-tunables",
  "GET /api/projects/:param/onboarding",
  "GET /api/projects/:param/orchestrator",
  "GET /api/projects/:param/plugin-surface",
  "GET /api/projects/:param/quality-metrics",
  "GET /api/projects/:param/runbooks",
  "GET /api/projects/:param/runbooks/content",
  "GET /api/projects/:param/scripts",
  "GET /api/projects/:param/sprint-capacity",
  "GET /api/projects/:param/stats",
  "GET /api/projects/:param/time-report",
  "GET /api/projects/:param/workspace-launch-failures",
  "GET /api/projects/:param/workspace-repo-status",
  "GET /api/projects/:param/workspace-risk",
  "GET /api/projects/:param/worktrees",
  "GET /api/projects/health",
  "GET /api/projects/registration-progress/:param",
  "PATCH /api/projects/:param/repos/:param",
  "PATCH /api/projects/:param/scripts/:param",
  "PATCH /api/projects/:param/statuses/:param",
  "POST /api/projects/:param/agent-questions/:param/answer",
  "POST /api/projects/:param/backlog.md/import",
  "POST /api/projects/:param/backlog.md/preview",
  "POST /api/projects/:param/backlog/import",
  "POST /api/projects/:param/butler/message",
  "POST /api/projects/:param/conductor",
  "POST /api/projects/:param/config/import",
  "POST /api/projects/:param/dependency-waves/start-next",
  "POST /api/projects/:param/drives",
  "POST /api/projects/:param/issues/import",
  "POST /api/projects/:param/issues/import/preview",
  "POST /api/projects/:param/onboarding/:param",
  "POST /api/projects/:param/onboarding/dismiss",
  "POST /api/projects/:param/repos",
  "POST /api/projects/:param/repos/:param/promote",
  "POST /api/projects/:param/scripts",
  "POST /api/projects/:param/voice-capture",
  "POST /api/projects/:param/worktrees/open",
  "POST /api/projects/generate-setup-script",
  "POST /api/projects/generate-teardown-script",
  "POST /api/projects/generate-verify-script",
  "PUT /api/projects/:param/butler/skill",
  "PUT /api/projects/:param/conductor-schedule",
  "PUT /api/projects/:param/drive",
  "PUT /api/projects/:param/stack-profile",
  // ── /api/scheduled-runs ──
  "DELETE /api/scheduled-runs/:param",
  "GET /api/scheduled-runs",
  "POST /api/scheduled-runs",
  "POST /api/scheduled-runs/:param/run",
  "PUT /api/scheduled-runs/:param",
  // ── /api/sessions ──
  "GET /api/sessions/:param/output",
  "GET /api/sessions/:param/summary",
  "GET /api/sessions/search",
  "POST /api/sessions/:param/stop",
  // ── /api/showdowns ──
  "GET /api/showdowns/:param",
  "POST /api/showdowns/:param/pick-winner",
  // ── /api/workers ──
  "DELETE /api/workers/:param",
  "GET /api/workers",
  "GET /api/workers/:param/events",
  "GET /api/workers/incoming",
  "POST /api/workers/pairing-token",
  // ── /api/workflows ──
  "DELETE /api/workflows/templates/:param",
  "GET /api/workflows/analytics",
  "GET /api/workflows/analytics/:param/:param/workspaces",
  "GET /api/workflows/resolve",
  "GET /api/workflows/templates",
  "GET /api/workflows/templates/:param",
  "GET /api/workflows/templates/:param/export",
  "GET /api/workflows/workspaces/:param/progress",
  "POST /api/workflows/templates",
  "POST /api/workflows/templates/import",
  "POST /api/workflows/workspaces/:param/transition",
  "PUT /api/workflows/templates/:param",
  // ── /api/workspaces ──
  "DELETE /api/workspaces/:param/comments/:param",
  "DELETE /api/workspaces/:param/stale-worktree",
  "GET /api/workspaces/:param/artifacts",
  "GET /api/workspaces/:param/artifacts-file",
  "GET /api/workspaces/:param/dev-server-plan",
  "GET /api/workspaces/:param/github-handoff-draft",
  "GET /api/workspaces/:param/latest-commit",
  "GET /api/workspaces/:param/plan",
  "GET /api/workspaces/:param/scorecard",
  "GET /api/workspaces/:param/services/logs",
  "GET /api/workspaces/:param/timeline",
  "GET /api/workspaces/:param/visual-proof",
  "PATCH /api/workspaces/:param/comments/:param",
  "PATCH /api/workspaces/:param/comments/:param/resolve",
  "POST /api/workspaces/:param/abort-rebase",
  "POST /api/workspaces/:param/bisect",
  "POST /api/workspaces/:param/comments",
  "POST /api/workspaces/:param/github-handoff-draft",
  "POST /api/workspaces/:param/merge",
  "POST /api/workspaces/:param/open-editor",
  "POST /api/workspaces/:param/repos/:param/rebase",
  "POST /api/workspaces/:param/retry-cleanup",
  "POST /api/workspaces/:param/services/down",
  "POST /api/workspaces/:param/services/restart",
  "POST /api/workspaces/:param/services/up",
  "POST /api/workspaces/:param/terminal",
  "POST /api/workspaces/:param/update-base",
  "POST /api/workspaces/preview",
];

/**
 * Call sites whose METHOD or PATH the scanner cannot resolve statically — a path built by a
 * helper (`butlerUrl(id, "/messages")`), a query string appended inside the last segment, an
 * `init` that is a variable rather than an object literal.
 *
 * These are NOT holes: `apiFetch` sees the concrete path at runtime, so a registered schema
 * still applies to them. They are the BLIND SPOTS OF THE SCANNER, and the count is down-only
 * for exactly that reason — moving a literal path behind a helper would otherwise shrink the
 * measured surface and read as progress.
 */
export const DYNAMIC_API_CALL_SITES: Readonly<Record<string, number>> = {
  // `/api/butler-definitions${path}` — same mixed-segment append as ButlerView.
  "components/ButlerManageModal.tsx": 1,
  // Every butler call is built by `butlerUrl(projectId, suffix)` (`lib/butler-url.ts`),
  // which appends a suffix to `/api/projects/${id}/butler` — a mixed segment the scanner
  // refuses to guess at rather than mis-attribute.
  "components/ButlerView.tsx": 13,
  // `/api/workspaces/cleanup-warnings${qs}` — a query string appended inside the last
  // segment. Reading it as a path parameter would have made it collide with
  // `GET /api/workspaces/:id`, which is registered; refusing to resolve it is the honest answer.
  "components/CleanupQueuePanel.tsx": 1,
  // The `init` is a variable, so the METHOD is not statically readable.
  "components/CreateWorkspaceForm.tsx": 1,
  // `.../stack-profile${refresh ? "?refresh=true" : ""}` — conditional query suffix.
  "components/StackProfileSettingsSection.tsx": 1,
  // The `init` is a variable, so the METHOD is not statically readable.
  "components/WorkspacePanel.tsx": 1,
  // `/api/plugins${query}` — query string appended inside the last segment.
  "components/settings/PluginsSettings.tsx": 1,
  // The `init` is a variable, so the METHOD is not statically readable.
  "components/settings/ProviderRotationRingEditor.tsx": 2,
  // The generic resource hook (#513): its whole contract is that the CALLER supplies
  // the path, so there is no literal here to read and never will be.
  "hooks/useApiResource.ts": 1,
  // `/api/workspaces/stale-worktrees${query}` — query string appended inside the last segment.
  "hooks/useStaleWorkspaceManager.ts": 1,
};

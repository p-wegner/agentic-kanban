I’ll use the repository’s kanban workflow guidance because this is ticket work, then read the repo instructions before touching anything. One constraint is already clear: this session’s filesystem is read-only with approvals disabled, so I can inspect and produce exact changes, but I cannot actually edit files or commit from this harness.

I’ve read the repo and workflow instructions. Since writes and commits are blocked by the current permission profile, I’m going to use the time to map the affected surfaces precisely and give you an implementation-ready plan or patch outline instead of pretending I can mutate the worktree.

I found the existing shared primitives in `packages/shared/src/lib/dependency-graph.ts` and the overlap helper in `packages/shared/src/lib/coupling-overlap.ts`. Next I’m tracing how issue dependency batch updates are exposed through server routes, MCP tools, and the board bulk-selection UI so the proposed contraction operation fits existing patterns.

The existing server route already has a transactional dependency batch endpoint; the MCP tool currently duplicates that logic instead of sharing the server service. For this ticket, the narrowest backend path is to add a service method that computes the contraction mutations with the shared graph helper and delegates to `updateDependenciesBatch`, then expose that from both REST and MCP.

I also found two UI entry points: the kanban bulk bar and the table bulk bar. The kanban bar is simpler and already passes selected issue records; the table bar is driven by selected ids and a reusable `tableView-bulk-ops` helper, so both need a small “contract selected” command that posts the selected ids to the new route.

I have enough context to be specific. I’m not going to run `pnpm test:mine` because no implementation changes can exist in this read-only session; running it now would only test the pre-existing branch state and would not satisfy the requested validation.

I can’t complete the edit or commit due to the read-only sandbox, but the integration points are now pinned down: add one server service method, one route, one MCP registrar, and two UI bulk actions. I’m doing a last pass over the types and tests so the final handoff is actionable rather than vague.

I couldn’t implement or commit this because the session is running with `sandbox_mode=read-only` and `approval_policy=never`. The filesystem only permits reads under the worktree, so any file edit, test that writes artifacts, or `git commit` is blocked by the harness regardless of the ticket instructions.

I did trace the implementation surface. The scoped change should be:

1. Backend service
   - In [issue.service.ts](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/server/src/services/issue.service.ts:1), import `resolveCoupledComponent` and `planContraction` from `@agentic-kanban/shared/lib/dependency-graph`.
   - Add `contractCoupledIssues(issueIds: string[], leadIssueId?: string)` near `updateDependenciesBatch`.
   - Validate non-empty `issueIds`, all found, same project, and selected set equals the resolved `coupled_with` component for the chosen lead.
   - Load all project dependency rows via existing `getDependencyRowsForProjects`.
   - Convert rows to `{ from, to, type }`, call `planContraction(leadId, members, edges)`, then delegate to `updateDependenciesBatch`.
   - Return `{ leadIssueId, memberIssueIds, mutations, added, removed, skipped }`.

2. REST
   - In [issues.ts](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/server/src/routes/issues.ts:1), add:
     - `POST /api/issues/contract-coupled`
     - Body: `{ issueIds: string[]; leadIssueId?: string }`
     - Map `BAD_REQUEST` to 400 and `NOT_FOUND` to 404, same route error style as existing bulk endpoints.

3. MCP
   - Add `packages/mcp-server/src/tools/contract-coupled-issues.ts`.
   - Register `contract_coupled_issues` in [index.ts](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/mcp-server/src/index.ts:1).
   - Reuse the same shared graph helpers. Ideally extract shared DB logic later, but for this ticket mirror the existing MCP batch-tool injection style.
   - Args: `{ issueIds: z.array(z.string()).min(1), leadIssueId: z.string().optional() }`.

4. Client UI
   - In [useBoardBulkSelection.ts](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/client/src/hooks/useBoardBulkSelection.ts:1), add `handleBoardContractCoupled`, posting selected ids to `/api/issues/contract-coupled`.
   - In [BoardBulkActionBar.tsx](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/client/src/components/BoardBulkActionBar.tsx:1), add a disabled-aware “Contract coupled” button and wire it through [BoardPageView.tsx](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/client/src/components/BoardPageView.tsx:430).
   - In [tableView-bulk-ops.ts](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/client/src/lib/tableView-bulk-ops.ts:1) and [TableView.tsx](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/client/src/components/TableView.tsx:238), add the same bulk operation for table selection.

5. Tests
   - Extend [issues-batch.test.ts](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/server/src/__tests__/issues-batch.test.ts:182) with `POST /api/issues/contract-coupled` cases for success, incomplete component rejection, cross-project rejection, and cycle rollback.
   - Add MCP tests beside [update-dependencies-batch.test.ts](C:/andrena/.worktrees/feature_ak-914-combine-strongly-coupled-tickets-into-on/packages/mcp-server/src/__tests__/tools/update-dependencies-batch.test.ts:1).
   - Add focused client unit tests for the bulk helper and/or `BoardBulkActionBar`.

I did not run `pnpm test:mine -- --changed HEAD` because no implementation changes could be made in this read-only session, and I did not commit for the same reason.

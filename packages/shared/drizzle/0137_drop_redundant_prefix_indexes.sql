-- #813: drop nine indexes whose column list is a strict PREFIX of a wider index on the same
-- table. SQLite's planner uses a wider index for a predicate on its leading column(s), so the
-- narrow one serves no lookup the wider one does not — it is only maintained on every INSERT,
-- UPDATE and DELETE, and occupies pages in a 186 MB database.
--
-- #813 listed SEVEN. Nine are dropped here. The two extra ones are a direct consequence of
-- #812: the ticket's candidate list came from a read of the Drizzle SCHEMA files, and two of
-- the covering indexes existed only in the migrations. Once #812 declared them, the same
-- prefix rule surfaces two more narrow indexes that were redundant all along.
--
-- EVERY candidate was checked against the migrated schema, not against the schema files:
--
--   narrow                                    cols                     covered by (cols)                                          unique?
--   idx_workspaces_issue_id                   (issue_id)               idx_workspaces_issue_id_status (issue_id, status)          no / no
--   idx_issues_project_id                     (project_id)             idx_issues_project_id_status_id_status_changed_at          no / no
--   idx_issues_status_id                      (status_id)              idx_issues_status_id_status_changed_at                     no / no
--   idx_issues_project_id_status_id           (project_id, status_id)  idx_issues_project_id_status_id_status_changed_at          no / no
--   idx_sessions_workspace_id                 (workspace_id)           idx_sessions_workspace_id_status (workspace_id, status)    no / no
--   idx_project_statuses_project_id           (project_id)             project_statuses_project_name_unique (project_id, name)    no / YES
--   idx_base_branch_health_project_id         (project_id)             idx_base_branch_health_project_sha (project_id, sha)       no / no
--   idx_issue_comments_issue_id      [#812]   (issue_id)               idx_issue_comments_issue_id_created_at                     no / no
--   idx_issue_deps_issue_id          [#812]   (issue_id)               issue_dependencies_unique (issue_id, depends_on_id, type)  no / YES
--
-- Two checks the naive version of this gets wrong, both done explicitly:
--
--   PREFIX-NESS IS ORDERED. `(a)` is covered by `(a, b)`; `(b)` is NOT covered by `(a, b)`.
--   Every row above was verified column-by-column in `seqno` order via PRAGMA index_info, not
--   by name or by set membership. `idx_issues_milestone_id`, `idx_workspaces_status`,
--   `idx_sessions_status`, `idx_base_branch_health_created_at` and
--   `idx_issues_project_external_key` all LOOK like neighbours of a wider index and are NOT
--   prefixes of one, so none of them is touched.
--
--   A UNIQUE INDEX IS NEVER REDUNDANT, even when its columns are a prefix of a wider
--   non-unique one: it enforces a constraint, and no wider index can make that statement.
--   None of the nine is unique (the `unique?` column above reads narrow/wide). The last two
--   rows are the mirror case, which IS safe: the narrow index is non-unique and the COVERING
--   index is unique. A unique index is still an ordinary B-tree, so the planner uses it for a
--   leading-column lookup exactly like any other.
--
-- The #740 FK-leading-index invariant survives all nine, because every covering index leads
-- with the same column the dropped one did:
--   issues.project_id      -> idx_issues_project_id_status_id_status_changed_at
--   issues.status_id       -> idx_issues_status_id_status_changed_at
--   workspaces.issue_id    -> idx_workspaces_issue_id_status
--   sessions.workspace_id  -> idx_sessions_workspace_id_status
--   project_statuses.project_id     -> project_statuses_project_name_unique
--   base_branch_health.project_id   -> idx_base_branch_health_project_sha
--   issue_comments.issue_id         -> idx_issue_comments_issue_id_created_at
--   issue_dependencies.issue_id     -> issue_dependencies_unique
-- fk-leading-index-ratchet.test.ts asserts that, and index-hygiene-ratchet.test.ts asserts
-- the planner actually picks the covering index for the hot single-column reads.
--
-- DROP INDEX IF EXISTS, because a board that never applied one of the earlier migrations
-- would otherwise fail here; dropping an index is metadata-only and needs no table rebuild.
DROP INDEX IF EXISTS `idx_workspaces_issue_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_issues_project_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_issues_status_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_issues_project_id_status_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_sessions_workspace_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_project_statuses_project_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_base_branch_health_project_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_issue_comments_issue_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_issue_deps_issue_id`;

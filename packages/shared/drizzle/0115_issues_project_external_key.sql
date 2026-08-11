-- Perf review 2026-08-11: plugin-loop status reads run three prefix-LIKE queries on
-- issues.external_key (loop tickets, unmerged workspaces, session-cost rollup) per loop
-- per poll, always scoped to one project — with no index covering external_key, each was
-- a scan of the project's issues. (project_id, external_key) serves the equality +
-- LIKE-prefix shape directly.
CREATE INDEX IF NOT EXISTS `idx_issues_project_external_key` ON `issues` (`project_id`,`external_key`);

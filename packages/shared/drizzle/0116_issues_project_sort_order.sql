-- Perf review 2026-08-11 (G14e): every board/graph/cross-project issue fetch is
-- "WHERE project_id = ? ORDER BY sort_order". Without a covering index SQLite
-- resolves it via idx_issues_project_id plus a temp B-tree sort of the whole
-- project's issues on every request. (project_id, sort_order) serves the
-- equality + ORDER BY shape index-ordered, no sort step.
CREATE INDEX IF NOT EXISTS `idx_issues_project_sort_order` ON `issues` (`project_id`,`sort_order`);

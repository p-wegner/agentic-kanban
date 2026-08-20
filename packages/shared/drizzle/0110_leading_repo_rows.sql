ALTER TABLE `repos` ADD `is_leading` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
INSERT INTO `repos` (`id`, `workspace_id`, `project_id`, `path`, `name`, `default_branch`, `worktree_path`, `branch`, `base_branch`, `base_commit_sha`, `merged_head_sha`, `is_leading`, `created_at`)
SELECT
	'leading-' || w.`id`,
	w.`id`,
	NULL,
	p.`repo_path`,
	NULL,
	p.`default_branch`,
	w.`working_dir`,
	w.`branch`,
	COALESCE(NULLIF(w.`base_branch`, ''), p.`default_branch`),
	w.`base_commit_sha`,
	w.`merged_head_sha`,
	1,
	w.`created_at`
FROM `workspaces` w
JOIN `issues` i ON i.`id` = w.`issue_id`
JOIN `projects` p ON p.`id` = i.`project_id`
WHERE NOT EXISTS (
	SELECT 1 FROM `repos` r WHERE r.`workspace_id` = w.`id` AND r.`is_leading` = 1
);

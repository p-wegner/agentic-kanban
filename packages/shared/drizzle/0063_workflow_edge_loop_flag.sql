ALTER TABLE `workflow_edges` ADD `is_loop` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `workflow_edges`
SET `is_loop` = 1
WHERE `id` IN (
  SELECT e.id
  FROM `workflow_edges` e
  INNER JOIN `workflow_templates` t ON t.id = e.template_id
  INNER JOIN `workflow_nodes` from_node ON from_node.id = e.from_node_id
  INNER JOIN `workflow_nodes` to_node ON to_node.id = e.to_node_id
  WHERE (t.builtin_key = 'simple-ticket' AND from_node.name = 'Review' AND to_node.name = 'Implement')
     OR (t.builtin_key = 'simple-bug' AND from_node.name = 'Review' AND to_node.name = 'Reproduce & Fix')
     OR (t.builtin_key = 'hard-bug' AND from_node.name = 'Thorough Review' AND to_node.name = 'Fix')
     OR (t.builtin_key = 'research-task' AND from_node.name = 'Consult User' AND to_node.name = 'Deep Research')
     OR (t.builtin_key = 'migration-with-ai' AND from_node.name = 'Migrate (test-driven)' AND to_node.name = 'Migrate (test-driven)')
     OR (t.builtin_key = 'migration-with-ai' AND from_node.name = 'Consolidate' AND to_node.name = 'Migrate (test-driven)')
);

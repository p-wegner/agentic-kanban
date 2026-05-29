CREATE TABLE `workflow_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text REFERENCES `projects`(`id`),
	`name` text NOT NULL,
	`description` text,
	`ticket_type` text,
	`is_default` integer NOT NULL DEFAULT 0,
	`is_builtin` integer NOT NULL DEFAULT 0,
	`builtin_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL REFERENCES `workflow_templates`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`node_type` text NOT NULL DEFAULT 'normal',
	`status_name` text,
	`skill_id` text REFERENCES `agent_skills`(`id`),
	`skill_name` text,
	`max_visits` integer NOT NULL DEFAULT 0,
	`config` text,
	`pos_x` integer NOT NULL DEFAULT 0,
	`pos_y` integer NOT NULL DEFAULT 0,
	`sort_order` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL REFERENCES `workflow_templates`(`id`) ON DELETE cascade,
	`from_node_id` text NOT NULL REFERENCES `workflow_nodes`(`id`) ON DELETE cascade,
	`to_node_id` text NOT NULL REFERENCES `workflow_nodes`(`id`) ON DELETE cascade,
	`label` text,
	`condition` text NOT NULL DEFAULT 'manual',
	`sort_order` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE cascade,
	`from_node_id` text,
	`to_node_id` text NOT NULL,
	`summary` text,
	`triggered_by` text NOT NULL DEFAULT 'agent',
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_templates_project_id` ON `workflow_templates` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_workflow_templates_ticket_type` ON `workflow_templates` (`ticket_type`);
--> statement-breakpoint
CREATE INDEX `idx_workflow_nodes_template_id` ON `workflow_nodes` (`template_id`);
--> statement-breakpoint
CREATE INDEX `idx_workflow_edges_template_id` ON `workflow_edges` (`template_id`);
--> statement-breakpoint
CREATE INDEX `idx_workflow_edges_from_node_id` ON `workflow_edges` (`from_node_id`);
--> statement-breakpoint
CREATE INDEX `idx_workflow_transitions_workspace_id` ON `workflow_transitions` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `idx_workflow_transitions_to_node_id` ON `workflow_transitions` (`to_node_id`);
--> statement-breakpoint
ALTER TABLE `issues` ADD `workflow_template_id` text;
--> statement-breakpoint
ALTER TABLE `issues` ADD `current_node_id` text;
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `current_node_id` text;

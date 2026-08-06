ALTER TABLE `workspaces` ADD `review_preflight_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `review_preflight_error` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `review_preflight_signature` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `review_preflight_blocked_at` text;

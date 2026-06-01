ALTER TABLE `board_health_events` ADD `category` text;
--> statement-breakpoint
ALTER TABLE `board_health_events` ADD `issue_number` integer;
--> statement-breakpoint
CREATE INDEX `idx_board_health_events_category` ON `board_health_events` (`category`);

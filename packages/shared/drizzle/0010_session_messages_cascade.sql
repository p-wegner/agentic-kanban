PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `session_messages_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text,
	`exit_code` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `session_messages_new` SELECT * FROM `session_messages`;--> statement-breakpoint
DROP TABLE `session_messages`;--> statement-breakpoint
ALTER TABLE `session_messages_new` RENAME TO `session_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

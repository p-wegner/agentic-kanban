ALTER TABLE `workers` ADD `token_expires_at` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `prev_token_hash` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `prev_token_valid_until` text;
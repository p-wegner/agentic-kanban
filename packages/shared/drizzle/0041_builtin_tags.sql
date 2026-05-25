ALTER TABLE `tags` ADD COLUMN `is_builtin` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `tags` SET `is_builtin` = 1 WHERE `name` = 'needs-visual-verification';

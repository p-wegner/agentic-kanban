ALTER TABLE `workspaces` ADD `skill_id` text REFERENCES `agent_skills`(`id`);

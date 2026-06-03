ALTER TABLE `projects` ADD `default_skill_id` text REFERENCES agent_skills(id);

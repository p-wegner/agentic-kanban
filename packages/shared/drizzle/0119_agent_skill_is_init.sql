-- #462 — mark an agent skill (built-in or user-created) as a one-time project-init
-- step. An init skill's output is a durable artifact (docs, a profile, a review)
-- against a freshly imported project, not a code change; it is a suggestion the
-- onboarding wizard offers, never auto-run by the board itself.
ALTER TABLE `agent_skills` ADD `is_init` integer DEFAULT 0 NOT NULL;

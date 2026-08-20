-- #668 — a project could hold two statuses with the same name, so the board rendered two
-- columns called "Todo" (one with the issues, one permanently empty) and every by-name
-- lookup — the merge path, the monitor, most E2E specs — silently picked whichever came
-- first. Nothing enforced uniqueness and no seeding path guarded against it.
--
-- Heal first, then constrain. Order matters: the index cannot be created while duplicates
-- exist, and issues must be moved off a duplicate BEFORE it is deleted or their FK dangles.

-- 1. Move every issue sitting on a duplicate status onto the canonical row for that
--    (project, name) — the lowest rowid, which is deterministic and needs no timestamps.
UPDATE `issues`
SET `status_id` = (
  SELECT `keep`.`id`
  FROM `project_statuses` AS `keep`
  JOIN `project_statuses` AS `cur` ON `cur`.`id` = `issues`.`status_id`
  WHERE `keep`.`project_id` = `cur`.`project_id`
    AND `keep`.`name` = `cur`.`name`
  ORDER BY `keep`.`rowid`
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM `project_statuses` AS `cur`
  JOIN `project_statuses` AS `other`
    ON `other`.`project_id` = `cur`.`project_id`
   AND `other`.`name` = `cur`.`name`
   AND `other`.`rowid` < `cur`.`rowid`
  WHERE `cur`.`id` = `issues`.`status_id`
);--> statement-breakpoint

-- 2. Now every duplicate is empty, so dropping it loses nothing.
DELETE FROM `project_statuses`
WHERE `rowid` NOT IN (
  SELECT MIN(`rowid`) FROM `project_statuses` GROUP BY `project_id`, `name`
);--> statement-breakpoint

-- 3. The actual guarantee.
CREATE UNIQUE INDEX `project_statuses_project_name_unique` ON `project_statuses` (`project_id`,`name`);

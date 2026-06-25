-- Widen the issue_dependencies.type set with the symmetric `coupled_with` peer edge
-- (foundation for the contraction epic, #916). SQLite does not enforce the drizzle
-- text enum at the DB level, so no column DDL change is needed for the value itself.
-- Recreate the (issue_id, depends_on_id, type) unique index so a fresh apply matches
-- the schema exactly (mirrors 0023_dependency_types, which first introduced `type`).
DROP INDEX `issue_dependencies_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_dependencies_unique` ON `issue_dependencies` (`issue_id`, `depends_on_id`, `type`);

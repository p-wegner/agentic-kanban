# Decision 002: Align Documentation with Schema (or Vice Versa)

## Date: 2026-05-01

## Context

A full audit of the codebase vs documentation revealed 7 gaps where the actual DB schema, API surface, or MCP tool parameters diverge from what's documented in `docs/prd/03-data-model.md` and `docs/prd/04-agent-integration.md`.

Each gap below has two or three resolution options. Pick one per gap.

---

## Gap 1: Tags are global, not project-scoped

**What docs say**: Tag has `project_id` (`03-data-model.md` line 85) and ER diagram shows `Project 1──* Tag`

**What code has**: `tags` table has no `projectId` column — tags are global across all projects

### Options

- **[A] Fix docs — keep tags global**. Simpler for single-project MVP. Update `03-data-model.md` to remove `project_id` from Tag and change ER to `Tag (global)`. Quick, no migration needed.
- **[B] Fix code — add `project_id` to tags**. Add column, new migration, update seed data, update tag routes to scope by project. More work but prepares for multi-project.

---

## Gap 2: Workspace missing `name`, `archived`, `pinned`

**What docs say**: Workspace has `name: String?`, `archived: Boolean`, `pinned: Boolean`

**What code has**: Only `id`, `issueId`, `branch`, `workingDir`, `status`, timestamps

### Options

- **[A] Fix docs — drop those fields**. None of these are used in the UI. Workspaces are identified by branch name and linked issue. Update `03-data-model.md` to match actual schema.
- **[B] Fix code — add the columns**. New migration to add `name`, `archived`, `pinned` to workspaces table. Would enable workspace list filtering and pinning later.

---

## Gap 3: Repo table has `scripts` instead of `remote_url`, `setup_script`, `cleanup_script`

**What docs say**: Repo has `remote_url`, `setup_script`, `cleanup_script` as separate columns

**What code has**: A single `scripts` text column (JSON blob presumably), no `remote_url`

### Options

- **[A] Fix docs — match the simpler schema**. The `scripts` column is sufficient for MVP. `remote_url` is never displayed or used. Update docs to show `scripts: String?` only.
- **[B] Fix code — split into three columns**. Add migration: `remote_url`, `setup_script`, `cleanup_script`, drop `scripts`. More structured but overkill for current usage.

---

## Gap 4: Session missing `exit_code`, uses `ended_at` not `stopped_at`

**What docs say**: Session has `stopped_at: DateTime?` and `exit_code: Int?`

**What code has**: `ended_at` (no `exit_code`)

### Options

- **[A] Fix docs — rename and drop**. Update docs to use `ended_at` instead of `stopped_at`, remove `exit_code`. The agent subprocess isn't currently capturing exit codes anyway.
- **[B] Fix docs + add `exit_code`**. Rename `stopped_at` to `ended_at` in docs (match code), but add `exit_code` column to code since it's useful for debugging failed sessions.

---

## Gap 5: ProjectStatus missing `color`, `is_default`

**What docs say**: ProjectStatus has `color: String?` and `is_default: Boolean`

**What code has**: Only `id`, `projectId`, `name`, `sortOrder`, `createdAt`

### Options

- **[A] Fix docs — drop both fields**. Status colors aren't shown in the UI (columns use Tailwind colors). Default status is hardcoded in seed data ("Todo"). Update docs.
- **[B] Add both columns**. `color` would let users customize column colors. `is_default` would make "which column new issues land in" configurable instead of hardcoded. New migration + UI changes.
- **[C] Add `is_default` only**. The default-status logic is the more useful one. Column colors can stay hardcoded for now.

---

## Gap 6: MCP `list_issues` missing `tag` filter parameter

**What docs say**: `list_issues` accepts `{status?, priority?, tag?}` (`04-agent-integration.md` line 25)

**What code has**: Only `projectId` (required), `status?`, `priority?`

### Options

- **[A] Fix docs — remove `tag?`**. Tag filtering can be added later. Update the Tier 1 table to match.
- **[B] Fix code — add tag filter**. Join through `issue_tags`, filter by tag name or ID. Moderate effort since it requires a join query.

---

## Gap 7: Tags API lacks individual tag update/delete

**What docs imply**: Full CRUD for tags (the ER diagram and entity definition suggest full lifecycle)

**What code has**: Only `GET /api/tags` and `POST /api/tags`. No PUT/PATCH/DELETE for individual tags.

### Options

- **[A] Fix docs — note as Tier 2**. Document that tag CRUD is minimal for MVP. Full tag management is post-MVP.
- **[B] Add endpoints**. Add `PATCH /api/tags/:id` (rename/color) and `DELETE /api/tags/:id`. Low effort, a few route handlers.

---

## Summary Table

| # | Gap | Recommended | Effort if code change |
|---|-----|-------------|----------------------|
| 1 | Tags: global vs project-scoped | **A (fix docs)** | Migration + route changes |
| 2 | Workspace: name/archived/pinned | **A (fix docs)** | Migration, no UI |
| 3 | Repo: scripts vs split columns | **A (fix docs)** | Migration + repo routes |
| 4 | Session: exit_code, ended_at naming | **B (add exit_code)** | Small migration |
| 5 | ProjectStatus: color, is_default | **C (add is_default)** | Small migration |
| 6 | MCP list_issues: tag filter | **B (add tag filter)** | Join query in MCP tool |
| 7 | Tags API: missing update/delete | **B (add endpoints)** | Two route handlers |

## Status

- [x] Decision made — all recommendations accepted
- [x] Implementation — exit_code, is_default, tag filter, tag CRUD endpoints
- [x] Update affected docs (`03-data-model.md`, `04-agent-integration.md`, `state.md`)

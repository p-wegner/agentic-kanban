# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] - 2026-07-21

### Added
- **Multi-repo projects — manage repositories from the board.** The `++` header button now opens a
  **Repositories** panel that lists the leading repo (pinned, `LEADING`) plus every sibling, with
  add (local path / clone URL / create new) and remove inline. A repo-count badge on the button
  surfaces multi-repo membership at a glance.
- **Multi-repo projects — change the leading repo.** A new **Make leading** action promotes any
  sibling to lead the project, atomically swapping identity with the current leading (which becomes
  a sibling). Guarded against open workspaces, whose worktrees are tied to the current leading.
- Settings → Project Settings gained the previously-missing "Create new" add-repo mode, matching the
  header panel and the backend's three modes.

### Fixed
- **CLI `--json` output is no longer corrupted.** The `[db] opening …` startup diagnostic was
  written to stdout, so `pnpm cli -- <cmd> --json | jq` (and any machine-readable consumer) broke on
  the leading log line. It now goes to stderr.
- MCP tool catalog: `list_project_repos` / `add_project_repo` / `remove_project_repo` are now
  catalogued, so they appear in the Settings tool browser and the catalog↔runtime parity gate is
  green.
- Repaired three chronically-red server test suites at their true root cause:
  - `cli.test.ts` — migration bookkeeping was seeded by content-hash while the migrator tracks by
    tag, so the spawned CLI re-ran every migration (incl. the FK-toggling `0010`) on an
    already-migrated DB.
  - `git.service.test.ts` — the migration-renumber/rebase tests collided with worktree directories a
    killed prior run left behind; they now self-heal.
  - `merge-response-before-cleanup.test.ts` — the deferred post-merge teardown ran real
    `netstat`/`taskkill` on the worktree's derived dev ports (slow, and able to kill a live dev
    server); the port/supervisor killers are now injectable and stubbed in the test.
- Corrected a stale `workspace.service` fix-and-merge rebase-abort test assertion (#139).

### Security
- Patched the flagged production-dependency vulnerabilities: `hono` → 4.12.31 (direct + a workspace
  override for the copy the MCP SDK pulls transitively), plus workspace overrides for `ws`
  (≥8.21.0), `fast-uri` (≥3.1.2), `brace-expansion@2` (≥2.1.2), `ip-address` (≥10.1.1), and `qs`
  (≥6.15.2). `pnpm audit --prod` went from **5 high / 13 moderate** to **0 critical / 0 high**. One
  residual moderate remains (a newly-published `@hono/node-server` serve-static path-traversal,
  transitive via the MCP SDK); its fix requires a major bump the SDK pins away from, and it is inert
  for this localhost-only single-user app.

### Internal
- Decomposed the `project.service.ts` god-module back under the 1000-line ceiling: repo-set
  management (`createSiblingRepoDir`, `promoteRepoToLeading`, `createInitialCommit`) moved to
  `project-repos.service.ts` and `ProjectError` to `project-error.ts` (re-exported).
- Widened `updateProjectFields` to accept a transaction client so the leading-repo swap can run
  atomically.
- Removed the committed, machine-generated `.claude/smart-hooks-rules.json` (already gitignored) — its
  presence made the smart-hooks runner execute the full `test:mine` on every edit.

[0.1.9]: https://github.com/p-wegner/agentic-kanban/compare/v0.1.7...v0.1.9

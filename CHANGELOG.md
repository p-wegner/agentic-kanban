# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`scripts/pack-worker.mjs` — pair a worker machine without publishing a release.** Builds,
  packs, and prints an installable tarball; `--blob` also puts it on an ACP relay for a machine
  you cannot copy files to. It refuses to pack a tarball whose bin map lacks
  `agentic-kanban-worker`, and stamps a `<version>-dev.<sha>` prerelease so npm cannot serve a
  cached same-version copy from the registry in its place. `agentic-kanban-worker instructions`
  gained a matching step, because the runbook previously assumed the binary already existed.

### Fixed
- **A worker daemon whose supervisor died kept running, kept its board socket, burned a full CPU
  core, and logged nothing for three hours — and every indicator on the machine reported it as
  healthy and idle.** Three separate defects lined up. (1) `worker.log` is written by the
  *supervisor*, not the daemon, so orphaning the daemon freezes the log while it runs on; the tray,
  the dashboard and the restart guard all derive state from that log and so served a three-hour-old
  snapshot as the present. Worker state now carries `LogAgeSec`/`logStale` and an explicit
  `Orphaned` (daemon up, supervisor gone), both ranked *above* connection and session count in the
  verdict, because those are exactly the readings a frozen log falsifies. (2) The daemon was matched
  by "command line contains *agentic-kanban* and *worker*" — which the tray and the dashboard also
  satisfy, being files under `tools/worker-windows/`. Three processes matched and `-First 1` picked
  whichever Windows enumerated first, so `-Stop` could kill the **tray**, print `killed pid <tray>`
  and `stopped`, and leave the real daemon running. Matching is now on `--board`, carried only by
  the daemon's own argv, and query processes are excluded so a filter can never match the shell
  running it. Covered by `ak-worker-process-match.test.ps1`. (3) The restart guard trusted that log
  unconditionally, so on an orphaned worker it would have reported `0 sessions in flight, safe to
  proceed` from stale data — the precise reading that destroys work. It now refuses to present a
  stale log as fact.

- **`agentic-kanban-worker --version` reported a hardcoded `0.0.1`** regardless of which build was
  installed. Since worker builds are handed over as sha-stamped tarballs, `--version` is the one
  question that binary needs to answer honestly; it now reads the version from its own installed
  manifest and falls back to `unknown` rather than to any number.
- **The dev client published the unauthenticated board API to the network.** Vite binds `::`
  (every interface) on 5173 and proxies `/api`, `/health` and `/ws` to the loopback API, so a
  board brought up for cross-machine fleet work exposed every issue, transcript and merge
  endpoint on the VPN — the fleet-port split does not defend this, because the leak is the dev
  client rather than the API bind. Start a cross-machine board with `VITE_HOST=127.0.0.1`
  alongside `KANBAN_FLEET_HOST`; see decision 012.

- **Plugins — the board is extensible now.** Point Settings → Plugins at a repo containing a
  `kanban-plugin.json` and it contributes agent skills, one-shot scripts, framed dashboard views, a
  butler prompt fragment, and a project scaffold template. Install once, enable per project. The
  **Plugins board view** is where every capability is started, and each enabled plugin also gets
  **its own view** under the toolbar's Plugins dropdown tab (with a fullscreen toggle). Full guide:
  [docs/plugin-development.md](docs/plugin-development.md).
- **Plugin marketplace.** Install a plugin from a git URL or a local path in one click, and browse a
  per-machine catalog of installable plugins (`~/.agentic-kanban/plugins/marketplace.json`, a
  user-maintained JSON list). No remote registry — nothing phones home.
- **Board-owned converging loops.** A plugin declares a deterministic `plan` command that prints the
  outstanding work units; the board turns each into a ticket and runs it under the project's WIP
  limit, provider selection and auth rotation. Loop state *is* the tickets, so an open-ended
  analysis survives a restart and is visible on the board instead of buried in a private run-log.
  Loops can be paused individually, can declare a default workflow template (a new built-in
  *Analysis Task* template ships for plugin-launched tickets), and can write their output to a
  configured location instead of into the plugin checkout.
- **Worker fleet — agent sessions can run on other machines.** Pair extra machines as workers
  (`agentic-kanban-worker` now ships as a standalone binary) and the board schedules ticket work
  onto them; capacity becomes "the machines you've paired" rather than "this laptop". Workers dial
  the board like CI runners, so one behind NAT needs no inbound access. Includes a token-authed
  worker registry, live output streaming, label-based scheduling with an optional strict mode (no
  silent fallback to the board host), restart recovery, a hang watchdog for remote sessions, and a
  git transport so a remote worker clones from the board and pushes results back for an unchanged
  diff/review/merge flow. Manage it via command palette → **Worker Fleet**. Credentials never leave
  the worker's own machine. Rationale:
  [docs/decisions/012](docs/decisions/012-worker-fleet-compute-model.md).
  - Worker endpoints are served on their own opt-in listeners (`KANBAN_FLEET_PORT`,
    `KANBAN_GIT_HTTP_PORT`) so exposing a fleet never exposes the unauthenticated board API.
- **Garden view** — a whimsical board view rendering issues as plants whose growth stage tracks
  their column (seedling → sprout → bud → bloom, wilted for Cancelled), colored by priority.
- **Active-agent counts in the top-bar project tabs**, so a busy project is visible without
  switching to it.
- Board-feedback routing is now computed from how the board is *deployed* (git clone vs. npx vs.
  docker) rather than guessed, and the resulting instruction is rendered into every worktree's
  ticket-context file — so an agent working in another repo files board bugs in the right place.

### Fixed
- **Monitor / auto-drive reliability.** No longer spawns a duplicate workspace for an
  already-merged issue (#190); auto-recovers an idle workspace whose committed work is stranded on a
  stale base (#191); one stalled project can no longer starve the shared monitor cycle (#208);
  silent auto-start skips (WIP cap, contention, `no-auto-start` tag) are now explained instead of
  invisible (#179); and cancelled dependents are no longer resurrected by the post-merge follow-up
  cascade (#219).
- **Merge and reconcile correctness.** A merge lock held by a dead process is reclaimed immediately
  (plus merge-phase tracing) (#207); the merge gate carries real evidence instead of fabricating it
  at merge time (#182); the hand-merged reconciler no longer force-Dones unmerged issues on a
  recycled worktree name (#146); sibling-aware terminalization and leading `mergedHeadSha` stamping
  (#151); pending-sibling-merge detection fails closed on unresolvable refs (#152); and reconcile
  can no longer destroy uncommitted changes in a sibling worktree (#153). The verify gate now runs
  *before* the repo lock is taken, so a long verification no longer blocks other merges.
- **Containerized builders and service stacks.** Stop / cancel / hang-kill / kill-all now have a
  container leg (#154); Stop hooks are no longer run host-shaped inside a container (#158); a silent
  fallback to the host when containerized isolation was requested is now surfaced, and the stale
  downgrade flag is cleared when the setting is off (#160); Compose stop/restart respects the
  last-reference sharer check (#161); the Compose scanner understands `volumes`/`include`/`extends`
  for lint and port discovery and persists its findings (#162); and the reaper's inventory now sees
  container-less Compose residue — volumes, networks, images (#163).
- **Windows and environment.** Worktree on-disk leaf shortened to `ak-<N>`, reclaiming the
  `MAX_PATH` budget (#193); the zombie-worker sweep no longer depends on an English locale (it was
  silently dead otherwise) and no longer touches listening dev servers (#172); `./gradlew` and
  `./mvnw` are translated for `cmd.exe` (#181); PHP/Composer stack detection emits
  `php vendor/bin/<tool>` rather than the bare shim (#177); the Gradle verify plan handles the
  "`--tests` matched nothing" gotcha (#195); the node verify gate defaults to the project's quick
  test command instead of the full suite (#173); setup/verify script timeouts are configurable, the
  verify-gate budget is separate, and a killed script is no longer misreported as a failure (#192);
  transcript directory encoding now matches Claude's real scheme (#159); CLI/server DB resolution
  never adopts an empty local-checkout stub (#165); and leaked `%TEMP%` test-fixture projects are
  unregistered with a guard against future leaks (#166).
- **Plugin fixes from first real use.** Enabled plugins' skills are materialized into every
  provisioned worktree (#204) and pinned to LF so the preflight guard stops reading them as dirty
  (#217); a view readiness probe uses a dedicated `healthPath` with a `/` fallback (#215);
  `views[].serve.cwd` is honored so a view server can run in the project repo (#214);
  `{{leadingRepoPath}}` was added to the placeholder contract (#213); scaffold TODO markers no
  longer silently break scripts and loops (#199); and a UTF-8 BOM in `marketplace.json` is stripped
  before parsing.
- `prevent-cross-worktree-writes.js` is now scaffolded unconditionally (#216); `smart-hooks-rules.json`
  (machine-generated) is gitignored for scaffolded and registered projects instead of force-committed.
- An unresolvable HEAD no longer poisons the shared git-stats cache (#212).
- Board columns fill the full width again after a manual column resize.

### Internal
- Decision records: `012` worker fleet compute model; `#222` staged epic for dropping the
  workspace-mirror column.
- Repeated god-module decomposition to stay under the size ceiling (`plugin.service`, `builtin-skills`,
  `session-lifecycle`, and the two modules that were blocking every merge); the multi-repo code paths
  (`getRepoMergeStatus`, `rebaseRepo`, fix-and-merge, `updateBase`, reconcile stamping) were unified
  onto one repo view (#168).
- Real-docker CI smoke test for the Compose service-stack lifecycle (#164); a large batch of
  chronically-red and cross-merge-broken test suites repaired at their root cause, and the
  merge-gate timeout budget applied consistently.
- The built-in code-review skills now gate out low-value findings.

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

[Unreleased]: https://github.com/p-wegner/agentic-kanban/compare/v0.1.9...HEAD
[0.1.9]: https://github.com/p-wegner/agentic-kanban/compare/v0.1.7...v0.1.9

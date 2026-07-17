---
name: multirepo-lab
description: R&D harness for the board's Docker-Compose + multi-repo features. Stand up a disposable N-repo (6+) project with per-workspace service stacks, drive a deliberate mix of tickets through the board (single-repo, stack-heavy, cross-cutting-all-repos), watch where the workflow breaks, FILE the gaps as dev-board tickets (bug vs missing-feature, with root cause + fix location), then FIX them end-to-end (branch → tests → gates → merge → push). Use for "run the multirepo lab", "docker-compose lab", "exercise/dogfood the board's multi-repo or docker support", "find gaps in multi-repo/service-stack support", or "build a multi-repo toy and take the findings to fixes".
---

You are running a **lab**: the goal is not the toy app, it's discovering and closing gaps in the board's multi-repo + Docker-Compose service-stack support. A ticket "completes" the toy; a finding filed **and fixed** completes the lab. Read `## Architecture Patterns → Git service`, `## Server Resilience`, and the `### Worktrees` + `### Windows / hooks` notes in `CLAUDE.md` first; this skill operationalizes exercising them. Prior runs are captured in [[multirepo-docker-test-fixture]], [[multirepo-leading-repo-blindspot]], and [[docker-in-docker-already-supported]] — read those to avoid re-litigating settled ground.

**Board ops use the active project `agentic-kanban`.** Findings are filed against the DEV board (project `agentic-kanban`); the toy is a SEPARATE registered project. Tool precedence: MCP → CLI → REST (CLAUDE.md `## Board Operations`).

## The loop (one full pass)

Build → Register → Seed → Drive → Observe → File → Fix → Verify → Clean up. Don't stop at "findings filed" unless the user scoped it to analysis — the lab's payoff is the fix.

## Phase 0 — Preflight

- Dev server up + healthy (`dev-server` skill). Docker available: `docker version --format '{{.Server.Version}}'`. If no daemon, service stacks land `status:"error"` (non-fatal by design) — the multi-repo mechanics still exercise, but you can't verify live stacks; say so.
- Decide the fixture location and size with the user if unspecified: **new** fixture vs **extend** the existing `C:\projects\andrena\toy-multirepo` (already 6 repos, postgres+redis); how many repos; how far to drive (set up only / run a few live / full dogfood to merge).
- Never work on the DEV repo's `master` — branch first when you reach Phase 8.

## Phase 1 — Build the fixture (N repos, coherent domain)

- Pick a believable domain so cross-cutting tickets feel real (e.g. an orders platform: `backend`/orders [leading] + `web-ui` + `auth-svc` + `inventory-svc` + `notifications-svc` + `gateway`).
- Each service: `git init -b main`, `package.json` (`"type":"module"`, `test: "node --test"`), `src/server.js` (node:http, `/api/*` routes), a `node:test`, README, `.gitignore` (`node_modules/`, `.worktrees/`), initial commit. **Keep services dependency-free (node builtins only)** so worktrees install instantly and setup-script gaps don't mask the features under test.
- The **leading** repo carries the stack: a `docker-compose.yml` publishing `${KANBAN_SVC_<NAME>_PORT}:<internal>` per service (postgres+redis is a good 2-service stack), each health-gated. The board injects `KANBAN_SVC_<NAME>_PORT` for each name in `servicesConfig.ports`.
- Leave the cross-cutting target endpoints **unbuilt** (e.g. no `/api/version` yet) so a cross-cutting ticket has real work in every repo.

## Phase 2 — Register + configure the stack

- Register leading repo as a project (`pnpm cli -- register <path>` from the MAIN checkout, or `POST /api/projects/create`). Resolve the full `projectId` (UUID).
- Add each sibling: `POST /api/projects/:id/repos {"path":"C:/forward/slash/abs/path"}`. **Use forward slashes** — backslash JSON through `curl` (bash) fails with `invalid JSON body`.
- Set the stack: `PATCH /api/projects/:id {"servicesConfig":{"enabled":true,"composeFile":"docker-compose.yml","composeRepo":null,"ports":["db","cache"],"readyTimeoutMs":120000,"env":{"POSTGRES_PASSWORD":"kanban"}}}`.
- Per-repo config (exercises #71): a sibling may declare its OWN `setupScript` / `composeFile` via `POST`/`PATCH /api/projects/:id/repos/:repoId`. Its compose services join the workspace stack; its own `${KANBAN_SVC_*_PORT}` names are union-allocated.
- Confirm: `GET /api/projects/:id/repos` lists leading + siblings.

## Phase 3 — Seed the tickets (the mix is the instrument)

Create 5–10 issues (`POST /api/issues {projectId,title,description,priority,issueType}`) with a **deliberate** spread — the mix is what surfaces gaps:

| Kind | Purpose | Example |
|---|---|---|
| single-repo (sibling) | catches **leading-repo blind spots** — the highest-yield class | `auth-svc: add GET /api/verify` |
| stack-heavy (leading) | exercises the live stack end-to-end | `orders: persist to Postgres, connect via KANBAN_SVC_DB_PORT` |
| cross-cutting (ALL repos) | exercises atomic multi-repo merge + overlap | `ALL REPOS: add GET /api/version`; `ALL REPOS: bump version` |

Make ≥2 cross-cutting tickets **overlap the same files** (e.g. both touch `server.js` / `package.json`) to probe multi-repo conflict sequencing. Descriptions must name the exact repo(s), file(s), endpoint contract, "add a node:test", and "commit in each affected repo".

## Phase 4 — Drive via the board (parallel, live stacks)

- Launch workspaces: `POST /api/workspaces {"issueId":"..."}`. Each creates a coordinated worktree across **all** repos on one branch + its **own** isolated postgres+redis stack (`ak-<inst8>-ws-<ws12>-{svc}-1` on distinct free ports). Verify: `docker compose ls`, `docker ps`.
- Stage: run a first wave (one of each kind) to confirm mechanics, then fan out the rest. Provider must be real (`GET /api/preferences/settings` → `provider`≠`mock`).
- Watch with `scripts/snapshot.py` (bundled) — per-branch commits **per repo** + session status + readyForMerge. Re-run every couple minutes.
- Land via board features: mark-ready (`POST /api/workspaces/:id/ready-for-merge`) → merge (`POST /api/workspaces/:id/merge`); rebase overlapping ones (`POST /api/workspaces/:id/update-base {"mode":"rebase"}`); reconcile already-landed (`POST .../reconcile-as-done`). Prefer the board's own review/merge over hand-git.

## Phase 5 — Observe: the friction classes to probe

Actively check each — this is the finding checklist (all of these were real gaps once; verify they stay fixed and hunt new ones):

- **Leading-repo blind spots** — does a **sibling-only** ticket get reviewed/merged, or silently marked Done with work stranded on the branch? (Ground truth = each repo's `main`, NOT the board snapshot; use `snapshot.py`.) The class: any check computed on `workspace.workingDir` (leading) only.
- **Per-repo merge visibility** — `GET /api/workspaces/:id/repo-merge-status` should show per-repo `hasWork/ahead/merged/stranded`. Is a partial merge visible, or hidden behind the scalar `mergedAt`?
- **Per-repo setup/services** — do sibling `setupScript`s run in their worktrees? Do sibling `composeFile`s join the stack with their ports allocated?
- **Cross-cutting overlap** — do two all-repos tickets that collide on the same file get **sequenced** (overlap detected across siblings), or raced so the second strands with a conflict in every repo?
- **update-base multi-repo** — does rebase touch **every** repo's worktree, or leading-only?
- **Docker reachability / lifecycle** — host-reachable published ports; teardown on merge/delete/close with no leaked containers/volumes; no orphan stacks after a killed run.

## Phase 6/7 — File findings (dev board)

File each gap as an `agentic-kanban` issue: `priority` (critical/high/medium), `issueType` (`bug` vs `feature`), and a body with **Symptom → Root cause (file:line) → Fix → Impact**. Verify the most damning ones directly before filing (repro on the fixture). Prefer a small number of precise, root-caused tickets over a long speculative list. Cross-link related memory with `[[...]]`.

## Phase 8 — Fix

Only if the user asked to fix (they usually do here). Per finding:

- Branch off the DEV `master` first (`git checkout -b feature/<slug>`). Never edit master directly.
- Implement the fix. For schema changes: add a migration `NNNN_*.sql` (check the highest in the MAIN checkout `packages/shared/drizzle`) **+ a `_journal.json` entry with a monotonic timestamp**, and **rebuild `shared/dist`** (`npm run build` in `packages/shared`) before the server typechecks against the new columns.
- Test + gate before commit: `npx tsc --noEmit` (server + shared), the affected `npx vitest run <patterns>`, `node scripts/check-god-modules.mjs` (extract behind a facade if a file crosses 1000 lines), and the `git-exec-single-spawn` / `barrel-client-safety` / `migration-schema-drift` gates. Add a focused test per fix that would have caught the gap.
- Commit per ticket (message ends with the `Co-Authored-By` trailer from CLAUDE.md). Merge to master (`--no-ff`) and push only when the user asks.
- If a migration landed, **restart the dev server** (`dev-server` skill) so it applies on boot, and verify the new columns surface via the API.

## Phase 9 — Clean up + record

- Tear down every `ak-*` compose project (`docker compose -p <name> down -v`) — leave co-tenant stacks (e.g. `shift_app`) untouched. Prune the toy worktrees (`git worktree remove --force`). Confirm 0 `ak-*` containers.
- Update memory: the fixture's current shape ([[multirepo-docker-test-fixture]]), any new root-caused class ([[multirepo-leading-repo-blindspot]]), and MEMORY.md pointers.

## Gotchas that cost rounds (don't relearn)

- **Ground truth is each repo's `main`, not the board.** Sibling work stranded on a branch reads as "Done" on the board — always diff the mains.
- **Branch names get truncated** by `suggestBranchName` (`feature/ak-7-...-endp`). Match the real ref, don't assume the full title.
- **Never "strip conflict markers, keep both sides"** to union-merge — it produced duplicate `const`/broken braces. Resolve conflicts properly and `node --check` every file.
- **Repo registration wants forward-slash absolute paths** (backslash JSON → `invalid JSON body`).
- **CLI runs from the MAIN checkout; vitest runs from the worktree** (CLAUDE.md `### Worktrees`).
- **PowerShell/REST writes:** use `curl` (Bash) or MCP for API writes — `Invoke-RestMethod -Method Put/Patch` silently no-ops. Never name a var `$pid`.
- **New worktrees install real deps** (Dependency Symlinks OFF here) — `pnpm install` in a worktree is safe.

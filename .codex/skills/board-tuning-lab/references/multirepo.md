# Dimension: docker / multi-repo

Tune the board's atomic multi-repo merge, per-workspace Docker-Compose service
stacks, Docker-in-Docker, and (the highest-yield class) **leading-repo blind
spots**. This is the original, deepest-worked dimension — distilled from two
6-hour `/goal` sessions and 13 lab rounds.

> **This dimension is SEALED in memory.** Read [[multirepo-docker-test-fixture]],
> [[multirepo-leading-repo-blindspot]], and [[docker-in-docker-already-supported]]
> first. Across 13 rounds the multi-repo/Docker/DinD surface was driven to "no
> remaining known blind spot." **Only re-open it for a genuinely new topology**
> (a compose feature, a cross-project sharing shape, a lifecycle edge not already
> probed). Don't re-litigate settled ground.

## Instrument

`scripts/snapshot.py <projectId> [boardPort]` — for every non-closed workspace,
prints ws/session status, `readyForMerge`, and **which repos (leading + siblings)
have commits ahead of their base**. That per-repo view is the ground truth the
board summary hides: sibling-only work stranded on a branch reads as "Done" on
the board but shows here as `repos=[auth-svc:1]` never merged. Re-run every couple
minutes while driving. Ground truth = each repo's `main`, NOT the board.

## Fixture

- Pick a believable domain so cross-cutting tickets feel real (orders platform:
  `backend`/orders [leading] + `web-ui` + `auth-svc` + `inventory-svc` +
  `notifications-svc` + `gateway`). Existing fixture: `C:\projects\andrena\toy-multirepo`
  (10 repos + a running compose stack — extend it rather than rebuild).
- Each service: `git init -b main`, `package.json` (`"type":"module"`,
  `test:"node --test"`), `src/server.js` (node:http, `/api/*` routes), a
  `node:test`, README, `.gitignore` (`node_modules/`, `.worktrees/`), initial
  commit. **Dependency-free (node builtins only)** so worktrees install instantly.
- The **leading** repo carries the stack: a `docker-compose.yml` publishing
  `${KANBAN_SVC_<NAME>_PORT}:<internal>` per service (postgres+redis = a good
  2-service stack), each health-gated. The board injects `KANBAN_SVC_<NAME>_PORT`
  for each name in `servicesConfig.ports`.
- Leave cross-cutting target endpoints **unbuilt** so a cross-cutting ticket has
  real work in every repo.

## Register + configure the stack

- Register leading repo (`pnpm cli -- register <path>` from MAIN checkout, or
  `POST /api/projects/create`); resolve the UUID.
- Add each sibling: `POST /api/projects/:id/repos {"path":"C:/forward/slash/abs"}`
  — **forward slashes** (backslash JSON via curl → `invalid JSON body`).
- Set the stack: `PATCH /api/projects/:id {"servicesConfig":{"enabled":true,
  "composeFile":"docker-compose.yml","composeRepo":null,"ports":["db","cache"],
  "readyTimeoutMs":120000,"env":{"POSTGRES_PASSWORD":"kanban"}}}`.
- Per-repo config (exercises #71): a sibling may declare its own `setupScript` /
  `composeFile` via `POST`/`PATCH /api/projects/:id/repos/:repoId`. Its compose
  services join the workspace stack; its `${KANBAN_SVC_*_PORT}` names are
  union-allocated.
- Confirm: `GET /api/projects/:id/repos` lists leading + siblings.

## Seed the mix (the mix is the instrument)

| Kind | Purpose | Example |
|---|---|---|
| single-repo (sibling) | catches **leading-repo blind spots** — highest yield | `auth-svc: add GET /api/verify` |
| stack-heavy (leading) | exercises the live stack end-to-end | `orders: persist to Postgres via KANBAN_SVC_DB_PORT` |
| cross-cutting (ALL repos) | atomic multi-repo merge + overlap | `ALL REPOS: add GET /api/version` |

Make ≥2 cross-cutting tickets **overlap the same files** (`server.js` /
`package.json`) to probe multi-repo conflict sequencing.

## Drive

- `POST /api/workspaces {"issueId":"..."}` — each creates a coordinated worktree
  across **all** repos on one branch + its **own** isolated postgres+redis stack
  (`ak-<inst8>-ws-<ws12>-{svc}-1` on distinct free ports). Verify: `docker compose
  ls`, `docker ps`.
- First wave (one of each kind) to confirm mechanics, then fan out.
- Land via board features: mark-ready (`POST .../ready-for-merge`) → merge
  (`POST .../merge`); rebase overlapping (`POST .../update-base {"mode":"rebase"}`);
  reconcile already-landed (`POST .../reconcile-as-done`). Prefer board over hand-git.

## Friction checklist (probe every item)

- **Leading-repo blind spots** — does a **sibling-only** ticket get reviewed/merged,
  or silently marked Done with work stranded? (Ground truth = each repo's `main`,
  `snapshot.py`.) The class: any check computed on `workspace.workingDir` (leading) only.
- **Per-repo merge visibility** — `GET /api/workspaces/:id/repo-merge-status` should
  show per-repo `hasWork/ahead/merged/stranded`. Partial merge visible, or hidden
  behind scalar `mergedAt`?
- **Per-repo setup/services** — do sibling `setupScript`s run in their worktrees?
  Do sibling `composeFile`s join the stack with ports allocated?
- **Cross-cutting overlap** — do two all-repos tickets colliding on the same file
  get **sequenced** (overlap detected across siblings), or raced so the second
  strands with a conflict in every repo?
- **update-base multi-repo** — does rebase touch **every** repo's worktree, or
  leading-only?
- **Docker reachability / lifecycle** — host-reachable published ports; teardown on
  merge/delete/close with no leaked containers/volumes; no orphan stacks after a
  killed run. DinD is already supported ([[docker-in-docker-already-supported]]) —
  verify it stays, don't re-implement.
- **Cross-project shared sibling** — same repo registered under two projects,
  driven concurrently (round 12 sealed distinct-branch isolation; same-branch
  collision fixed via `findCrossProjectBranchHolders`).

## Known residual (do NOT re-file — board 0 open)

After a fix-and-merge close, the **leading** repo row still reads `merged:false` /
`mergedAt=None` (close path stamps only sibling rows, not the leading workspace's
`mergedHeadSha`/`mergedAt`). Cosmetic — `allMerged:true` + the mains are
ground-truth-correct. Deferred across rounds 10/11/13.

## Fixture-specific gotchas

- **Never "strip conflict markers, keep both sides"** to union-merge — produced
  duplicate `const`/broken braces. Resolve properly and `node --check` every file.
- **Sibling compose relative paths** (`env_file`/`secrets`/`configs`/`build`)
  resolve against the LEADING worktree (compose single-project-dir rule, not
  board-fixable) — dev #109 added a loud lint (`service-compose-lint.ts`).

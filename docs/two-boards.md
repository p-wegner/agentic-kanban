# Two boards on one machine — stable and dev

The board develops itself in the process that operates it: `pnpm dev` is `tsx watch` on the main
checkout, so every merge restarts the server driving the merge and a red master is a broken board.
That is the reason every gate has to be complete, and therefore slow
(`docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §3.A has the measurements).

The fix is two boards:

| | **Stable board** | **Dev board** |
|---|---|---|
| Checkout | a SECOND checkout of this repo, on tag `stable` | this checkout |
| Process | the built artifact — `pnpm build` + `pnpm --filter agentic-kanban start` | `pnpm dev:devboard` |
| Ports | **3001 / 5173** (unchanged) | **3101 / 5273** |
| Database | today's `~/.agentic-kanban/kanban.db`, PINNED via `KANBAN_DB_URL` | its own, `~/.agentic-kanban-dev/kanban.db` |
| Registered projects | all, **including `agentic-kanban`** | fixtures only (`exp/`), never its own checkout |
| May be red? | never | as long as necessary |

This page is the runbook. **Nothing here has been executed**: #1013 landed the code and the
document; the cutover is an operator step, and the checklist at the end is what to run.

---

## 1. The dev board — one command

```bash
pnpm dev:devboard          # = node scripts/dev.mjs --dev-board
```

or, equivalently, set the variable and use the ordinary launcher:

```bash
KANBAN_BOARD_ROLE=dev pnpm dev
```

`KANBAN_BOARD_ROLE=dev` is the single switch, and it decides **both** the ports and the database
(`scripts/dev-port-plan.mjs`, `scripts/dev-env.mjs`). They are deliberately not separable: a board
listening on the dev ports while pointing at the operated database is exactly the split-brain the
split exists to prevent. Anything other than the literal word `dev` — unset, empty, `development`,
`stable` — is the stable role, i.e. byte-for-byte today's behaviour.

What the switch does:

- **Ports.** `resolveDevPorts` bases off `3101 / 5273` instead of `3001 / 5173`. The worktree
  convention is unchanged and still applies, so a dev-board builder on `feature/ak-N-…` gets
  `3101+N / 5273+N` and never collides with the same-numbered worktree of the stable board.
- **Database.** `resolveDevBoardDbUrl` sets `KANBAN_DB_URL=file:<home>/.agentic-kanban-dev/kanban.db`
  and the launcher creates that directory. An explicit `KANBAN_DB_URL` you set yourself WINS — pointing
  the dev board at a snapshot is a supported workflow.
- **A refusal, not just a convention.** `assertDevBoardDbIsolated` throws if the resolved URL is
  either `~/.agentic-kanban/kanban.db` (the operated data, and the file the stable board is pinned
  to) or `<checkout>/packages/server/kanban.db` (the in-checkout rung `resolveDbLocation` would
  otherwise adopt). The dev board refuses to start rather than open them.

Everything else about `pnpm dev` is unchanged: the port guard, the supervisor, the preflights.

### Seeding the dev board

The dev DB starts empty. `pnpm db:migrate && pnpm db:seed` against it creates schema and default
tags/skills; register fixtures from `C:\projects\andrena\exp\` with `pnpm cli -- register <path>`.
**Do not register this checkout on the dev board** — see §3.

## 2. The stable board — built artifact, pinned DB

```bash
git -C <stable checkout> fetch origin --tags
git -C <stable checkout> checkout stable
cd <stable checkout>
pnpm install -r
pnpm build
KANBAN_DB_URL=file:C:/Users/<you>/.agentic-kanban/kanban.db \
  pnpm --filter agentic-kanban start
```

`start` is `node packages/server/dist/cli/index.js dev` — it migrates and seeds on first run. The
mechanics of the built path (where migrations and bundled skills resolve from, and what to check
when a built board misbehaves) are in **[install.md § "Running the BUILT board"](install.md)**, and
`pnpm smoke:boot-dist` (#1012) is the check that the artifact boots at all. Do not re-derive that
here.

**Why the DB is pinned rather than moved.** Today's live board data is the home fallback
`~/.agentic-kanban/kanban.db` (there is no in-checkout `packages/server/kanban.db`). Pinning it in
place with `KANBAN_DB_URL` means nothing on disk moves, and every other consumer that resolves the
same file by the same fallback keeps agreeing with the board — which is what makes §4 come out
"no change needed".

## 3. Exactly one board registers `agentic-kanban`

**The stable board registers it; the dev board never does.**

Both boards see the same git repository on disk. `createWorktree` reuses an existing worktree for a
branch, and git allows exactly one worktree per branch — so two boards each creating
`feature/ak-N-…` for the same repo silently SHARE one worktree and one branch. That is #110, fixed
for the same-branch case within one board by `findCrossProjectBranchHolders`; two independent boards
with independent databases have no such shared view and the guard cannot fire.

So: the `agentic-kanban` project row lives in the operated database, which the stable board owns.
The dev board carries fixture projects only. If you want the dev board to have a project pointing at
board code, point it at a throwaway clone, not at this checkout.

## 4. MCP configs in `~/.claude*` — verified, nothing to change

Checked, not assumed:

- Every board client resolves the port through **one ladder**,
  `resolveBoardServerPort` (`packages/shared/src/lib/board-server-url.ts`):
  `KANBAN_BOARD_SERVER_PORT || KANBAN_SERVER_PORT || SERVER_PORT || PORT || 3001`. The MCP server
  re-exports it as `getServerPort` (`packages/mcp-server/src/server-url.ts`).
- The MCP server resolves the DATABASE through `resolveDbLocation`
  (`packages/mcp-server/src/db.ts`): explicit `KANBAN_DB_URL`/`DB_URL`, then `AGENTIC_KANBAN_DIR`,
  then the in-checkout candidate `packages/server/kanban.db`, then `~/.agentic-kanban/kanban.db`.
- There is **no `agentic-kanban` entry in `~/.claude.json`'s `mcpServers`** and none in the
  `settings*.json` profiles; the board writes its own config at spawn time
  (`getMcpConfigPath` / `getMcpServersConfig`, `packages/server/src/services/agent-provider/helpers.ts`),
  forwarding `SERVER_PORT` and `DB_URL` from the board that spawned the agent.

Consequence: an MCP client with no env of its own lands on **port 3001 and the home-fallback DB** —
which is exactly the stable board and exactly the file it is pinned to. **No MCP configuration
changes.** A client that should talk to the DEV board must be given both
`KANBAN_SERVER_PORT=3101` and `KANBAN_DB_URL=file:<home>/.agentic-kanban-dev/kanban.db`; giving it
only one of the two is the split-brain `db-path.ts`'s #962 note describes.

## 5. `KANBAN_MAIN_CHECKOUT` for builders of the dev board

`KANBAN_MAIN_CHECKOUT` is how the hook scripts self-locate; `smart-hooks-runner.js` and
`validate-command-safety.js` prefer it over their `git rev-parse` fallback, and it names the
**main checkout of the repository the worktree belongs to** — not "the machine's board".

A builder started by the DEV board works in a worktree of THIS checkout, so for it
`KANBAN_MAIN_CHECKOUT` must name **this checkout** (`C:\projects\andrena\agentic-kanban`), exactly
as today. It must NOT name the stable checkout: the guards use it to decide which tree a write is
allowed to touch, and pointing it at the stable checkout would both mislocate this checkout's
guards and describe the stable tree as writable.

A builder of a project registered on the STABLE board is a worktree of that project's repo and gets
that repo's main checkout, likewise unchanged. Neither board sets it to the other's tree.

## 6. The stable checkout is a FOREIGN repo for builders — verified in the guard code

Read from `.claude/hooks/prevent-cross-worktree-writes.js` rather than assumed:

- `foreignRepoCheck` is armed whenever the authorized root came from `KANBAN_WORKTREE_DIR`, which
  the board sets for every builder it launches. For a target path it calls `containingRepo(path)` —
  walking up to the nearest existing directory and asking `git rev-parse --show-toplevel`, so a
  file that does not exist yet is still attributed to the repo that would contain it.
- It returns the offending repo unless the path is inside the authorized worktree, equals it, or is
  a **sibling workspace worktree** — and `isSiblingWorkspaceWorktree` requires containment under the
  authorized worktree's own `…/.worktrees/` root.
- A sibling stable checkout at `C:\projects\andrena\agentic-kanban-stable` satisfies none of those:
  it is not inside the builder's worktree, and it is not under that worktree's `.worktrees/` root.
  So it is classified foreign and `foreignRepoBlock` hard-refuses — through both doors, file writes
  (`Write`/`Edit`, checked per resolved target) and shell commands (`git -C <stable> commit`, a `cd`
  into it, a redirect into it).
- **This holds however the second checkout is made.** As a separate `git clone` it is a different
  repository and the check above applies. As a `git worktree add` of this repo it additionally
  appears in `git worktree list`, so the older same-repo cross-worktree check blocks it as well.
  Two independent refusals, not one.

Reads are still allowed everywhere, deliberately — a builder may read the stable checkout, only
never write into it.

## 7. Operator cutover checklist

Nothing below has been run. Do it in this order.

1. **Tag the stable point.** On the main checkout, with a green full sweep behind it:
   `git tag stable-YYYYMMDD && git tag -f stable stable-YYYYMMDD`.
2. **Create the second checkout.** `git worktree add C:\projects\andrena\agentic-kanban-stable stable`
   (or a clone at that path). Do not register it on any board.
3. **Build it.** `pnpm install -r && pnpm build` in that checkout, then `pnpm smoke:boot-dist` once
   to confirm the artifact boots (#1012).
4. **Stop the current `pnpm dev` on 3001/5173.** Per the `dev-server` skill — kill the port owner by
   signature, never all node.
5. **Start the stable board** with the pinned `KANBAN_DB_URL` (§2). Verify: `GET /health` on 3001,
   `GET /api/projects` lists the real projects including `agentic-kanban`, one `get_board_status`.
6. **Start the dev board**: `pnpm dev:devboard` in this checkout. Verify 3101 answers `/health`,
   5273 serves the UI, and `GET http://127.0.0.1:3101/api/projects` is EMPTY (or holds only
   fixtures) — a dev board that lists the real projects means the DB pin is wrong; stop and fix
   before doing anything else.
7. **Seed the dev board** (§1) and register the `exp/` fixtures you want.
8. **Leave MCP configs alone** (§4). Re-check one MCP call from an unrelated repo — it must answer
   from the stable board.
9. **Move board development to the dev board**: file/start `agentic-kanban` tickets on the STABLE
   board (that is where the project lives), but let a red master on this checkout stop nothing.
10. **Promotion** — tag, fast-forward the stable checkout, rebuild, restart, smoke — is a separate
    ticket (`promote`), deliberately not scripted here.

## 8. What is deliberately NOT here

- **The `promote` script.** Its own ticket; §7.10 is the manual form.
- **A second repository.** A second CHECKOUT is enough and keeps tags, history and hooks in one
  place (proposal §5).
- **Any runtime change.** #1013 is code and docs. No server was started, no database moved, and
  `scripts/board-monitor/objective.md` is untouched.

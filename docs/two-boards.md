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
| Ports | **3001** — API *and* UI, one process (unchanged) | **3101 / 5273** (API proxy / Vite) |
| Database | today's `~/.agentic-kanban/kanban.db`, PINNED via `KANBAN_DB_URL` | its own, `~/.agentic-kanban-dev/kanban.db` |
| Registered projects | all, **including `agentic-kanban`** | fixtures only (`exp/`), never its own checkout |
| May be red? | never | as long as necessary |

**5173 is not a stable-board port.** A dev run has two processes (a proxy on 3001 and Vite on
5173); the BUILT artifact is one process that serves the compiled client from the same port as the
API. So after the cutover nothing listens on 5173 at all, and a browser bookmark for the board is
`http://127.0.0.1:3001`. The dev board keeps both ports because it is still a `pnpm dev`.

This page is the runbook. §7 was **executed on 2026-09-05** (#1013's acceptance: a second session
following it cold); the corrections that run produced are folded in below. §8 (`pnpm promote`) has
still never been run.

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

**Usually nothing to do: the first `pnpm dev:devboard` migrates and seeds the dev DB itself.** The
`dev` command runs first-time setup when no database exists (`dbExists()` → migrate → seed), so the
board comes up on an empty-but-seeded database — measured on the 2026-09-05 cutover: 0 projects,
3 tags, 22 agent skills, without a single explicit db command.

If you ever do need to run them by hand, **pass the dev DB explicitly**:

```bash
KANBAN_DB_URL=file:$HOME/.agentic-kanban-dev/kanban.db pnpm db:migrate
KANBAN_DB_URL=file:$HOME/.agentic-kanban-dev/kanban.db pnpm db:seed
```

A bare `pnpm db:migrate` / `pnpm db:seed` in this checkout does **not** reach the dev board.
`KANBAN_BOARD_ROLE` is read by `scripts/dev.mjs`, not by the CLI, so those commands fall through
`resolveDbLocation` to the home fallback and open the OPERATED database
(`[db] opening C:\Users\<you>\.agentic-kanban\kanban.db (source: home-fallback)` — verified).

Register fixtures from `C:\projects\andrena\exp\` with `pnpm cli -- register <path>`, likewise with
`KANBAN_DB_URL` pointed at the dev DB. **Do not register this checkout on the dev board** — see §3.

## 2. The stable board — built artifact, pinned DB

**After a reboot, `pnpm stable:start` is the sanctioned door** (#1202,
`node scripts/promote.mjs --restart-stable`) — it starts the ALREADY-DEPLOYED tag with none of a
promotion's other work: no sweep is read, no tag is minted, nothing is fetched, fast-forwarded,
built or migrated. It refuses (exit 2, nothing spawned) if the port is already held, using the
same `planPortOwnerKill` signature check `pnpm promote` uses to stop the board — but this door
never kills whatever it finds there. Every run — refused or started — is logged to
`.kanban/promote.log` as a `restart-only` line, so the Sentinel sees it. `--dry-run` previews
without touching anything. Reach for a full `pnpm promote` only when you actually want to move
the stable checkout onto new code; reach for this after the box came back up and 3001 did not.

The commands below are what that door runs under the hood — useful for understanding what it
does, or as a manual fallback if the script itself is unavailable, but not the sanctioned path:

```bash
git -C <stable checkout> fetch origin --tags
git -C <stable checkout> checkout stable
cd <stable checkout>
pnpm install -r
pnpm build
KANBAN_DB_URL=file:C:/Users/<you>/.agentic-kanban/kanban.db \
  node <stable checkout>/packages/server/dist/cli/index.js dev --port 3001 --no-open \
  >> <stable checkout>/.kanban/board.log 2>&1
```

**Append the output to `.kanban/board.log`, not `.kanban/promote.log`.** The promote log is the
run-by-run audit trail the Sentinel reads; a board process holds its fd open for days, and putting
both on one file already cost one promotion its opening record (§8, "The two logs").

**Spawn the built CLI by its absolute path, not `pnpm --filter agentic-kanban start`** — the same
form `scripts/promote.mjs` uses, and for the same two reasons (both hit on the 2026-09-05 cutover):

- `start` carries no `--no-open`, so the `dev` command's `options.open` defaults to true and it
  runs `cmd /c start http://…` — a browser and a flashed window on a board you are launching
  headless.
- Through `pnpm --filter`, the node process's command line is the relative `dist/cli/index.js dev`
  and contains the stable checkout's path nowhere. §8's `planPortOwnerKill` refuses any pid whose
  command line does not contain that path, so a board started that way is one `pnpm promote`
  cannot stop: the promotion aborts, or — worse, on a machine where the listener lookup comes back
  empty — starts a second board over the first.

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

Run on 2026-09-05 (tag `stable-20260905` = `stable` = `e01438a4c5`). Do it in this order.

1. **Tag the stable point.** On the main checkout, with a green full sweep behind it:
   `git tag stable-YYYYMMDD && git tag -f stable stable-YYYYMMDD`.
2. **Create the second checkout.** `git worktree add C:\projects\andrena\agentic-kanban-stable stable`
   (or a clone at that path). Do not register it on any board. As a worktree it lands on a
   **detached HEAD** at the tag — that is fine, `git merge --ff-only <tag>` in §8 works detached.
3. **Build it.** `pnpm install -r && pnpm build` in that checkout, then `pnpm smoke:boot-dist` once
   to confirm the artifact boots (#1012). ~2 min for the install, ~1 min each for the build and
   the smoke (8/8 checks) on a 16-core box.

   **From an agent session, every command that MUTATES the stable checkout needs the override
   prefix `ALLOW_CROSS_WORKTREE_WRITE=1`.** `.claude/hooks/prevent-cross-worktree-writes.js` sees a
   `cd` into another checkout as the #369 vector and blocks it — correctly, it cannot tell an
   operator cutover from a builder wandering off — so the install, the build and the smoke are all
   refused without it. §6 is the same guard seen from the builder's side: what makes the stable
   tree safe from builders is what makes the operator prefix the command here. An operator at a
   plain shell needs none of this.
4. **Stop the current `pnpm dev` on 3001/5173.** Per the `dev-server` skill — kill the port owner by
   signature, never all node. **Stop 13001 too**: 3001 is only the proxy, and the `tsx` backend that
   holds the DB open lives on `port + 10000`. Walk the parent chain to the `dev.mjs` supervisor or
   it respawns what you killed.
5. **Start the stable board** with the pinned `KANBAN_DB_URL` (§2) — absolute CLI path, `--no-open`,
   `nohup`/detached, **output appended to `<stable>/.kanban/board.log`** (never `promote.log`, which
   is the promotion audit trail — §8 says what mixing them cost). Verify: `GET /health` on 3001, `GET /api/projects` lists the real projects
   including `agentic-kanban`, one `get_board_status`, and the startup log says
   `[db] opening …\.agentic-kanban\kanban.db (source: DB_URL)`. Nothing binds 5173 any more — the
   built artifact serves the UI on 3001; check `GET http://127.0.0.1:3001/` returns the app HTML.
6. **Start the dev board**: `pnpm dev:devboard` in this checkout. Verify 3101 answers `/health`,
   5273 serves the UI, and `GET http://127.0.0.1:3101/api/projects` is EMPTY (or holds only
   fixtures) — a dev board that lists the real projects means the DB pin is wrong; stop and fix
   before doing anything else. Its log must say
   `[db] opening …\.agentic-kanban-dev\kanban.db (source: DB_URL)`.
7. **Seed the dev board** — normally already done by step 6's first run (§1); register the `exp/`
   fixtures you want, with `KANBAN_DB_URL` pointed at the dev DB.
8. **Leave MCP configs alone** (§4). Re-check one MCP call from an unrelated repo — it must answer
   from the stable board. Cheapest check without a client:
   `cd <unrelated repo> && node <stable>/packages/server/dist/mcp.js < /dev/null`, which prints
   `[mcp-db] opening …\.agentic-kanban\kanban.db (source: home-fallback)` — the operated DB, i.e.
   the stable board's.
9. **Move board development to the dev board**: file/start `agentic-kanban` tickets on the STABLE
   board (that is where the project lives), but let a red master on this checkout stop nothing.
10. **Promotion** — tag, fast-forward the stable checkout, rebuild, restart, smoke — is §8.

## 8. Promotion — `pnpm promote`

> **Decision 019 (2026-09-24) changes what this section gates.** The sweep and the tag move to a
> release-candidate branch (`rc/<date>`) that master does not wait for; a red candidate is healed
> on the candidate by a board ticket and merged back. Until #1238/#1239 land, everything below
> describes the current master-gated run. The ladder across postures is
> `docs/integration-risk-ladder.md`.

Master reaches the stable checkout by a TIMED promotion, never per merge (proposal §3.A, Yegge's
drawbridge). That is the one moment the full suite decides anything. `scripts/promote.mjs` is that
moment; the checklist above is its manual form.

```bash
pnpm promote --dry-run        # print the resolved sha, tag and every step; touch nothing
pnpm promote                  # promote — triggering and AWAITING a sweep when one is needed
pnpm promote --no-await-sweep # never trigger one; refuse when the recorded verdict is unusable
pnpm promote --recover --reason "<why>"   # FAST LANE: no sweep at all (#1054)
pnpm promote --force-sweep    # promote WITHOUT a green sweep verdict, loudly
```

### The RECOVERY lane (`--recover`, #1054)

The full lane's precondition is a fresh green **full sweep** — a throwaway clone + install + full
verify, 45-minute ceiling. For a LOCAL, single-user board that is the wrong trade, and #1053 is what
it cost: #1039's fix sat undeployed for a day because the last green sweep was on the sha stable was
already running, so the honest path was a no-op and only `--force-sweep` got through. The motivating
case is *"the running board has a memory leak, ship the fix now"* — where the gate is slowest exactly
when the machine is degraded and the fix is most urgent.

**Its premise is that steps 3-4 of the run above ALREADY are a gate.** Build, migrate, restart,
smoke — and a failed build, a board that will not boot, or a failed smoke all roll back automatically
to the previous `stable-*` tag. Blast radius is one person's local board, noticed in seconds,
recovered in about 90 seconds.

**It gates on exactly one thing: a migration in the delta.** `deployRef` runs the forward-only
`db:migrate` on whatever it deploys — *including on the rollback* — so a schema change is the only
thing a failed recovery cannot undo. Everything else is one `git reset --hard` away. That refusal is
an ACK, not a prohibition: `--with-migration` proceeds, because an operator refused on the day their
fix happens to carry a schema change is an operator who goes back to `--force-sweep`, and that is how
a loud escape hatch stops being loud.

What it deliberately does NOT do: cap the delta by size (it PRINTS the commits and files instead —
on a single-user board the operator is the review), pre-run typecheck/arch/guards (`pnpm build`
already catches most of it for a small delta, and the smoke catches what matters), or refuse a second
recovery in a row (it warns).

On a **passing smoke** — never before, since a recovery that rolled back owes nothing — it writes
`<stable>/.kanban/promote-recovery.json` with `sweepOwed: true`, the tag, the sha, the rollback
target and the delta. That is disclosure, not repair: #1044 already fixed the structural half (a
green sweep that ends up *behind* what stable runs triggers a fresh one instead of refusing). What
was missing is that nobody could TELL the board was running unswept code.

It is **not** `--force-sweep` with a friendlier name: that flag checks nothing at all and says so in
a banner, while this is the routine fast path with a real (if narrow) gate and an audit trail.
Passing both refuses; `--with-migration` outside the lane refuses.

> **Unrehearsed as of 2026-09-07.** The lane is implemented and unit-tested, but no `--recover`
> promotion has run end to end and its rollback path has not been exercised
> (`KANBAN_PROMOTE_FORCE_SMOKE_FAILURE=1` is the seam).

**Executed for real on 2026-09-05 (#1014's acceptance).** Five runs against the live pair: two
promotions that came up green on 3001 against the operated database (`stable-20260905-2`,
`stable-20260905-5`), two rehearsed rollbacks, and one run that REFUSED before tagging. What each
of them corrected is folded into the sections below.

### What one run does

1. **Reads the last full-sweep verdict for `master`** out of the board's `base_branch_health`
   table — the row the nightly probe writes through `recordBaseBranchHealth`
   (`packages/server/src/services/base-branch-health.service.ts`). It never re-runs the suite.
   Preferred source is the board's own API, `GET /api/projects/:id/base-branch-health`; when no
   board answers it falls back to a **read-only** `node:sqlite` SELECT against
   `KANBAN_PROMOTE_DB`. It never writes to that database.

   Only `green` and `red` are verdicts — `timeout` and `unverified` are non-answers about the
   PROBE (`isBaseHealthAnswer`, #935), and a non-answer refuses just as a red does. So does a
   green older than `KANBAN_PROMOTE_MAX_SWEEP_AGE_H` (default 36h) and a sweep recorded on
   another branch. Every refusal names the sweep's **sha, date and verdict**.
2. **Refuses a sha the stable checkout is already AHEAD of** (`checkPromoteDirection`). The green
   sweep is by construction older than master's tip, and after a hand-made cutover the stable
   checkout can already sit on a later commit — where `git merge --ff-only <ancestor>` reports
   "Already up to date" and exits 0. Without this check the run would tag, rebuild, restart, smoke
   green and announce a tag that is **not what runs**. That is exactly what the first real run on
   2026-09-05 was about to do.

   **This check and the sweep check together used to form a trap — see "Where the evidence comes
   from" below, which is what closes it.**
3. **Tags `stable-YYYYMMDD` on that green sha** — `-2`, `-3`, … when the day already has a tag.
   Two promotions in one day is normal, and moving the existing tag would erase the rollback
   target.
4. **In the stable checkout** (`KANBAN_STABLE_CHECKOUT`, default the sibling
   `../agentic-kanban-stable`; **refused when absent or dirty** — the script never creates or
   cleans it): `git fetch origin --tags`, `git merge --ff-only <tag>`, then
   `pnpm install -r --prefer-offline` **only if `pnpm-lock.yaml` moved**, `pnpm build`,
   `pnpm --filter agentic-kanban db:migrate` with the pinned `KANBAN_DB_URL`, and a restart.
5. **Smoke:** `GET /health`, `GET /api/projects` (**non-empty** — an empty list means the DB pin
   is wrong, §4), and one `GET /api/issues?projectId=…`, the HTTP equivalent of
   `get_board_status`. On failure it fast-forwards the stable checkout back to the previous
   `stable-*` tag, rebuilds, restarts, re-smokes and says so loudly. When there is NO previous
   tag it says that instead of pretending it recovered.
6. **Retires the failed tag** once a rollback came up healthy: `stable-YYYYMMDD-N` is renamed to
   `failed-promotion-stable-YYYYMMDD-N`. The rollback target is the newest `stable-*` tag, so
   leaving it there would let the NEXT failed promotion roll back onto a version that already
   failed its own smoke. The name stays taken (retired names are fed back into the tag chooser),
   so a second, different sha can never wear a label a post-mortem already knows.

### Where the evidence comes from — the run ASKS for a sweep (#1044)

**The trap.** A promotion needs a green sweep whose sha the stable checkout is not already past.
`--force-sweep` promotes the branch TIP, which moves stable **ahead** of the last recorded sweep —
so the next honest run reads a green verdict for an ANCESTOR of what is already deployed, step 2
correctly refuses it as `behind`, and the only way out is another `--force-sweep`. Each forced run
therefore made the next honest one structurally impossible. Observed across the six runs on
2026-09-05: runs 5 and 6 both went through `--force-sweep`, and run 6's plain attempt refused for
exactly this reason. A loud escape hatch that becomes the routine path is no longer loud.

**The shape chosen: promote triggers the sweep it needs, and waits.** The ticket offered two —
trigger-and-wait, or reschedule the sweep to follow every promotion. Trigger-and-wait was taken
because it puts the evidence on the run that needs it: a promotion is an operator action at a
moment of their choosing, and a post-promotion schedule would still leave a run started at an
awkward time with a stale verdict and nothing to do about it. It also fails in the right
direction — a probe that never lands leaves the run refusing exactly as before, whereas a
scheduled sweep silently widens the window every time one is skipped.

When the only thing missing is a CURRENT verdict, the run `POST`s
`/api/projects/:id/base-branch-health/reprobe`, polls `base_branch_health` until a **different
observation** lands (a new (sha, timestamp) pair — never "green", never "a row exists"), and then
judges it with the same `parseSweepVerdict` as a sweep that happened on its own clock. A request
the board declines (`gate_running`, `host_saturated`) is retried each poll rather than treated as
failure — waiting those out is the point. Cap: `KANBAN_PROMOTE_SWEEP_WAIT_MIN`, default 40 minutes,
which is probe-sized (clone + install + full verify), after which the run refuses.

Which refusals it will fix, and which it will not (`planSweepAcquisition`, `scripts/promote-plan.mjs`):

| Situation | Trigger a sweep? |
|---|---|
| green verdict, but `behind` the stable checkout | **yes** — this is the trap itself |
| `no-sweep`, `stale`, `not-an-answer`, `no-sha`, `wrong-branch` | **yes** |
| last sweep was **red** | no — master is broken; re-probing it is dice-rolling, not evidence |
| the verdict was **unreadable** | no — the reprobe goes through the same board that did not answer |
| `--force-sweep` | no — that run consults no verdict at all |
| `--no-await-sweep` | no — refuse immediately, the pre-#1044 behaviour, for a caller that cannot wait |

**`--force-sweep` is unchanged and still logs its three-line banner.** What changed is that the
mechanism no longer *requires* it: two consecutive promotions with no manual sweep in between both
take the honest path, because the second one asks for its own evidence instead of inheriting a
verdict the first one moved past.

### Two-board skew is now board-visible (#1055)

#1039 landed on master and sat "Done" for a full day while the stable board kept running the
pre-fix code — the stable checkout only moves on a promotion, and nothing on the board said
"master is ahead of what's actually running." `generateBoardRiskDigest`
(`services/board-risk-digest.service.ts`) now surfaces this via `computeStableSkew`
(`services/stable-skew.service.ts`): it finds the newest local `stable-*` tag (the same tag
`pnpm promote` creates in this repo — see "1. tags `stable-YYYYMMDD[-N]`" above) and diffs the
project's default branch against it. The digest gains a `stableSkew` field (`null` when the repo
carries no `stable-*` tag, or master is not ahead of it) and, when any of the ahead commits look
`fix(#N)`/`feat(#N)`-shaped, a `stable_skew` risk item naming the count — so a "Done" ticket whose
fix isn't live yet shows up next to the other things an operator should not trust blindly.

This reads local tags only (no network call, no assumption the stable checkout is even
reachable), which is also why it degrades to `null` rather than erroring on a project that isn't
run under this two-board setup at all — most projects the board manages have no `stable-*` tag.

**Decided against a targeted "sweep this fix now" trigger, distinct from `--await-sweep`/
`--recover`.** #1055 asked whether a fix that needs to go live quickly needs its own machinery to
request an urgent sweep. It doesn't, given what already exists on this branch: `--await-sweep` is
the DEFAULT since #1044 (a promotion already asks for and waits on a fresh sweep rather than
refusing), and `--recover --reason "..." [--with-migration]` (#1054) is the fast lane for exactly
the "ship this now" case, skipping the sweep on the premise that the existing build → migrate →
restart → smoke → auto-rollback pipeline already is the gate for a local single-user board. Adding
a THIRD lane that ties a sweep request to a specific issue number would duplicate one of these two
without buying anything neither already covers — `base_branch_health` has no issue/workspace FK
(§8 above), and there is no per-ticket subset of "verify the whole base branch" to target even if
one were added. If a future need shows up that neither lane covers (e.g. "this issue's fix,
verified in isolation before the rest of master"), it is a new kind of question — a NARROWED
sweep, not a faster trigger for the existing one — and belongs to its own ticket.

### Accumulated-gate evidence — printed, never counted (#1045)

Every pre-merge gate already writes one row into the test-impact ledger
(`recordVerifyGateOutcome` → `impact.mjs record` → `.test-impact/outcomes.jsonl` in the MAIN
checkout: the suites selected, the ones dropped below the score floor, pass/fail, runtime and the
change set). Nothing read them, so ten green gates covering a hundred files gave a promotion zero
evidence. `pnpm promote` now summarizes what has accumulated **since the last sweep** and prints it
beside the verdict, in the dry run and in `promote.log`:

```
  gate evidence    7 green gate run(s) covering 43 changed file(s) since the last sweep (…)
                   [1 red, 2 suspect (excluded)] — WEAKER THAN A SWEEP: each was a ranked
                   SELECTION over one branch's diff, not the full suite over the base.
                   Authorizes nothing.
```

**It decides nothing, deliberately.** A gate is a selection over one branch's diff, scored against
a possibly-stale impact map; a sweep is the full suite over the base branch itself. They are
different measurements and one is not N of the other, so `summarizeGateEvidence` returns counts
and no boolean — a threshold here would be `--force-sweep` with a friendlier name. Rows the
producer itself tagged as non-observations (`ci-nochange`, `ci-partialselection`,
`ci-unattributed`) are counted separately and excluded from the headline, for the same reason the
skill's own miss-rate report excludes them.

The same ledger is the corpus **#954** needs before the `impact` gate tier can become anyone's
default — it comes out of runs the board is already paying for. `impact.mjs stats --outcomes
<ledger>` is the miss-rate report and runs off those real entries today (37 rows as of
2026-09-05); the rate itself still reads `UNKNOWN` because no full-scope failing run has yet named
its failed suites, which is #954's problem, not the ledger's.

### Rehearsing the rollback

`KANBAN_PROMOTE_FORCE_SMOKE_FAILURE=1 pnpm promote` fails the promotion's smoke **on purpose**,
after `/health` has already answered — so the restart is still proven — and the flag is then
consumed, which makes the ROLLBACK's smoke a real check of the rolled-back board. That one-shot
property is the point: a seam that failed both smokes would leave the rollback unverifiable.
Never set it for a real promotion. A rehearsal exits **1** (not a crash: the failure path sets
`process.exitCode` rather than calling `process.exit` next to a just-spawned detached child,
which used to abort node with a libuv assertion and hand a cron a crash code).

### How the stable board is stopped and started

Stopping is **by process signature only** — never a broad `node` kill. The script finds the
LISTENER on `KANBAN_STABLE_PORT` (netstat/lsof) and passes it through `planPortOwnerKill`, the
same guard `scripts/dev.mjs` uses: a pid whose command line does not contain the stable
checkout's path is REFUSED, not killed, and the promotion aborts. So it cannot take down another
agent's worktree server, the dev board, or anything else that happens to hold the port.

**#1035 (fixed, and proven by a real promotion).** `parseNetstatListeners` used to match the
literal state token `LISTENING`, and a German `netstat -ano` prints `ABHÖREN` — so
`stopStableBoard()` logged "nothing listening on 3001 — nothing to stop" and `startStableBoard()`
would have spawned a SECOND board over the running one, with the signature guard never reaching a
pid at all. A listening row is now identified by its WILDCARD foreign address, which no locale
translates. Verified end to end by the promotions above: each one logged
`{"action":"dev-port-kill-allowed", ...}` for the running board's pid and that pid actually died.

Starting spawns the BUILT artifact directly — `node <stable>/packages/server/dist/cli/index.js
dev --port <port> --no-open` — which is what `pnpm --filter agentic-kanban start` runs (§2),
spawned as `node` so the process command line carries the stable checkout's path and the stop
step above can recognise it next time. `windowsHide: true`, `detached` + `unref`, stdio into
`.kanban/board.log`: headless, no window flash, and it outlives the promoting shell.

**`pnpm stable:start` (#1202) reuses exactly this start step and the same signature check on the
STOP side of the decision, without ever calling stop.** It runs the same listener lookup and the
same `planPortOwnerKill` check the paragraph above describes, but only to decide whether to
refuse — a pid already on the port is always a refusal here, never a kill, whether or not it
turns out to belong to the stable checkout. That is what makes it a door a reboot can use even
when nobody is sure the board is really down: worst case it refuses and says who is already
there. See §2 for the day-to-day framing.

### The two logs — and why they are two

Every step is appended to **`<stable checkout>/.kanban/promote.log`** — that is the file the
Sentinel reads. The board a promotion STARTS logs to **`<stable checkout>/.kanban/board.log`**
instead. A `--dry-run` writes nothing at all; it prints where it *would* log, naming both.

They were one file until 2026-09-05, and the promotion's own record is what that cost. The 10:02
run's header, sweep line, rollback target, direction check, tag and fast-forward were absent from
`promote.log` afterwards, while the outgoing board's `[loop-lag]` output for the same minutes was
there; the run had demonstrably happened — git carried `stable-20260905-6`, and the file still held
that same run's `SMOKE PASSED` — but its opening record was not there to read. The loss mechanism
was never proven (both writers append, and appends should not clobber), which is exactly why the
fix is separation rather than a cleverer write: a run's audit trail must not depend on how a server
process that will hold its fd for days happens to buffer.

**So when you start a stable board by hand, send its output to `board.log`, not `promote.log`** —
that is what §7 step 5 does, and the collision above began with a hand launch that did otherwise.

## 9. What is deliberately NOT here

- **A promotion SCHEDULE.** `pnpm promote` is by hand or from whatever timer the operator wires
  it to; nothing in the board runs it. "Once a day, idle" is a policy, not a script.
- **A second repository.** A second CHECKOUT is enough and keeps tags, history and hooks in one
  place (proposal §5).
- **Any runtime change from #1013 itself.** #1013 was code and docs only. (#1014's promotion runs
  DID start and stop the stable board on 3001 — by signature, against the operated database, which
  a promotion only ever migrates and reads. No database was moved and
  `scripts/board-monitor/objective.md` is untouched.)

# Dimension: ticket sizing

Find and tune the board's ticket-granularity sweet spot. **Too small** and the
agent spends more turns exploring (finding files, loading context, understanding
the repo) than implementing — the fixed exploration cost dominates and throughput
per token craters. **Too large** and the agent stalls, loses the thread, or
strands a partial merge. The lever is the board's **enhancer / splitter /
dependency-analyzer** and the guidance it gives when sizing a backlog. The gap
class here is *the board doesn't right-size work before handing it to an agent.*

## Instrument

Per ticket, the **exploration-vs-implementation ratio**, read from the builder's
transcript via `session-inspector`:

- `analyze-claude-session.mjs <session> --json` → tool-call breakdown. Classify
  calls as **exploration** (Read / Grep / Glob / `ls` / `cat` Bash) vs
  **implementation** (Edit / Write / test-running Bash). A healthy ticket is
  implementation-dominated; a too-small ticket is exploration-dominated (the agent
  spent its budget just getting oriented for a trivial change).
- Also track **turns-to-first-Edit** (orientation cost) and **total tokens per
  merged unit of work** (`token-sinks.mjs --by session`).

Baseline = drive the SAME feature carved three ways (one big / several medium /
many tiny) and compare the ratios. The right size minimizes total tokens and
exploration-ratio for the delivered feature. This is a controlled A/B/C, not a
single run.

## Fixture

A single coherent feature with **natural internal seams** (e.g. "add a tagging
system": model + migration + API + UI + validation + tests) so it can be honestly
carved at three granularities without changing the total work. Dependency-free
build per `references/multirepo.md` rules.

## Seed the mix (three carvings of ONE feature)

| Carving | Tickets | Hypothesis |
|---|---|---|
| **coarse** | 1 ticket: "add the whole tagging system" | high stall/strand risk, but low per-unit exploration |
| **medium** | 3–4 tickets along real seams | expected sweet spot |
| **fine** | 8–10 micro-tickets ("add one field", "add one route") | exploration cost dominates; per-ticket overhead swamps the work |

Drive all three (fresh workspaces, same provider), measure each carving's
aggregate ratio + tokens. Add a **negative control**: one genuinely atomic
one-line ticket that *should* be tiny (confirms fine-grained isn't always wrong —
the enhancer must not over-split truly atomic work).

## Friction checklist

- **Does the enhancer/splitter right-size?** Feed it the coarse ticket — does
  `ticket-enhancer` / a splitter break it along the medium seams, or leave it
  monolithic / shatter it into fines?
- **Exploration ratio per carving** — is fine-grained measurably worse
  (exploration-dominated) as hypothesized? By how much?
- **Stall/strand rate on coarse** — does the big ticket actually stall or partial-merge?
- **Guidance surfaced** — does the board *tell* a human when a backlog ticket looks
  mis-sized, or silently hand it over?
- **Dependency ordering** — for the medium carving, does `dependency-analyzer`
  sequence the seams correctly so they don't collide?

## Fix locus

`ticket-enhancer` skill / prompt, any splitter logic, `dependency-analyzer`, and
the backlog-refill sizing guidance. A fix = the board produces medium-carving-sized
tickets (or flags mis-sized ones) from a coarse or over-fine input, verified by a
better re-measured exploration ratio on the re-sized backlog.

## Note

This is the most *empirical* dimension — the "sweet spot" is a measured curve, not
a rule. Record the actual numbers per carving in the round's memory note so the
next round refines the curve instead of re-running the A/B/C from scratch.

## Round-1 gotchas (2026-07-19 — see [[ticket-sizing-lab-round1]])

- **Parallel carvings = separate PROJECTS.** Clone ONE fixture into 3 sibling projects
  (`tsz-coarse/medium/fine`), each with its own repos, so the carvings drive
  concurrently without worktree/branch collision. Drove all three, sonnet builders.
- **The splitter is `decomposeEpic`, not just the enhancer.** `POST /api/issues/:id/
  decompose` returns a PROPOSAL (children + deps + a multi-repo `repos` field) without
  mutating — safe to probe on live tickets. `enhanceIssue` only polishes (fine on
  atomic tickets); the gap was decompose over-fragmenting. Fix locus was the decompose
  prompt + a new pure guard `decompose-sizing.ts`.
- **The cheap probe finds the gap before the expensive drive.** Decomposing the atomic
  negative control (route → "add route" + "add test for route") surfaced the whole
  finding for ~2 AI calls; the A/B/C drive only *quantified* why it matters (fine ≈
  3-5x tokens). Do the enhancer/splitter probe FIRST, then drive.
- **Measure from raw transcripts, not the board.** The sessions/search API needs message
  content (returns 0 by name); `GET /api/sessions/:id/summary` needs session ids you
  can't easily enumerate. Ground truth = `~/.claude/projects/<encoded-worktree-path>/
  *.jsonl` (glob with a REAL `C:/Users/...` path — the bash `/c/...` form fails Python
  glob). Classify tool_use: Read/Grep/Glob = explore, Edit/Write + test/commit Bash =
  impl; sum `usage` for tokens. Output tokens (billed, no cache inflation) is the honest
  metric; total incl. `cache_read_input_tokens` balloons but is consistent across
  carvings so the RATIO holds.
- **Never burst-launch workspaces.** ~10 concurrent multirepo `POST /api/workspaces`
  crashed the whole `pnpm dev` stack twice (vite ws-proxy → client exit → recursive-run
  fail → backend down; filed dev #117). Launch in batches of ~3, health-check between.
- **The DB safety guard blocks ANY command naming `kanban.db`** — even a read-only
  `better-sqlite3` open. Use the REST API for session/board data, never direct DB reads.
- **Don't tag `no-auto-start` for the negative control** — issue tags need a pre-existing
  `tagId`, and with `auto_monitor` off nothing auto-starts anyway; just don't drive it.

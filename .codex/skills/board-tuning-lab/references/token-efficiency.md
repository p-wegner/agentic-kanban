# Dimension: token efficiency

Tune how many tokens the board's **builder agents** burn to complete a ticket.
Cost is cache-read dominated — every turn re-bills the whole context — so the
lever is *what the board injects into an agent's context*: the worktree's
materialized skills, the ticket prompt, the objective/monitor preamble, and the
tool-results the agent accumulates. The gap class here is *the board makes the
agent pay for context it never uses.*

## Instrument

The **session-inspector fleet tools** read the builder agents' own transcripts
(billed tokens, not estimates — rule 2). Run them scoped to the fixture project:

- `token-sinks.mjs --project <fixture> --by session` — the billing total per run;
  which ticket cost what.
- `waste.mjs --project <fixture>` — attributes context to buckets weighted by
  persistence (tokens × turns-survived); flags re-reads, repeated identical Bash
  output, node_modules leaking into Glob/Read — the *avoidable* slice.
- `context-growth.mjs --project <fixture>` — the SHAPE (auto-compacts, long-context
  >200k tax) that multiplies everything.
- `context-spikes.mjs --project <fixture>` — the single injections that bloat
  context, each classified with a fix (huge-file / verbose-output / log-wall / …).
- `skill-usage.mjs --project <fixture> --cost` — **the board-specific lever**:
  which skills the board *materializes into every worktree* but no agent ever
  fires (`loaded-only`, strong=0), weighted by always-on token tax.

Baseline = drive the fixture once, record per-ticket tokens + the top waste
buckets. Fix. Re-drive an equivalent ticket. The metric moved iff tokens dropped
for equivalent work.

## Fixture

A small, dependency-free single- or few-repo fixture (per `references/multirepo.md`
build rules) with a handful of **well-specified, equivalent-difficulty tickets**
so per-ticket token deltas are comparable across the baseline/after runs. Keep
the actual coding trivial — you're measuring the *overhead* the board adds, not
the difficulty of the work. A ticket that just adds one endpoint + one test is
ideal: most of its token cost is context the board injected, which is what you're
tuning.

## Seed the mix

- 3–4 near-identical tickets (same shape, different endpoint) → run half as
  baseline, half after the fix, compare.
- One ticket that would tempt an agent into an avoidable waste pattern (reading a
  huge generated file, re-reading a file already in context) — a **trap** to
  confirm the board's guidance/tooling steers away from it.

## Friction checklist

- **Skill materialization tax** — how many skills does the board copy into each
  worktree's `.claude/skills`, and how many ever fire? A `loaded-only` skill pays
  always-on tax every turn for nothing (`skill-usage.mjs --cost`).
- **Prompt/objective bloat** — is the injected ticket prompt / objective / monitor
  preamble carrying content the builder doesn't need?
- **Tool-result bloat the board could prevent** — does the board's tooling
  encourage ranged reads / quiet flags, or let agents dump whole files & verbose
  output (`context-spikes.mjs` by class/file)?
- **Re-read waste** — same file Read twice, same Bash output repeated
  (`waste.mjs`).
- **Cold-cache tax** — does the board park agents idle past the cache TTL, forcing
  a full-prefix re-write on resume? (`cold-cache.mjs`.)

## Fix locus

The board's context-injection code paths: worktree skill materialization
(`agent_skills` → `.claude/skills/` writer), the ticket/objective prompt builders,
the monitor preamble, and any tool wrapper defaults. A fix = the board injects
*less* or *steers better*, verified by a lower re-measured token number for
equivalent work. Cutting a materialized-but-never-fired skill is the cleanest win.

## Watch your own cost too

These lab runs are themselves huge (500k+ peak ctx, 6h). `/clear` between rounds;
drive with a leaner provider where the dimension allows; this dimension's tools
work on *your* session too.

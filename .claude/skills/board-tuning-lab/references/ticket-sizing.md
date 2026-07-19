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

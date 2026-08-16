---
name: refactoring-scout
description: Hunt for HIGH-POTENTIAL refactorings and code reorganizations that improve architecture and maintainability — especially implemented WORKAROUNDS (special-cases, duplicated guards, string-sniffing, flag soup, copy-drifted helpers, back-compat shims) that a MINIMAL abstraction (one function, one type, one table, one seam) would replace, simplify, or turn into an extension point. Findings are filed as kanban tickets. Use for "find refactorings", "where are the workarounds", "what could a small abstraction simplify", "scout for reorganizations", "prepare the code for extension X".
---

# refactoring-scout

You are a pragmatic staff engineer scouting for refactorings that pay for themselves. You are NOT
doing a general architecture review (that's `architecture-review` / `adversarial-arch-review`) and
you are NOT hunting bugs. You are looking for one specific thing:

> **A place where the code has been *made to work* by a workaround, and where a *minimal*
> abstraction would replace several workarounds at once, simplify an existing pattern, or make
> a foreseeable extension a one-line change instead of a hunt.**

"Minimal" is the discipline. A finding that needs a framework, a new package, or a rewrite is
out of scope. The best findings look like: *"these 6 call sites each re-derive X with slightly
different bugs; one `resolveX()` in shared would delete ~120 lines and fix 2 latent
inconsistencies"* or *"this `if (kind === 'a' || kind === 'b')` chain appears in 4 files; a
`KIND_TRAITS` table makes the next kind a table row"*.

## Inputs
- Optional focus: a package, directory, or an intended future extension ("we'll add a 4th
  agent provider", "a second DB backend"). With a focus, weight findings by whether they
  *prepare* that extension. Without one, sweep the whole repo.
- Optional **exclusion list**: a file listing findings already filed (ticket # + one-line gist)
  and candidates already rejected (with reason). Read it FIRST and skip anything that is the
  same idea; when a new finding is a *sibling* of a filed one, say so and reference the ticket
  instead of refiling. Return your own rejected list so the caller can extend the file.
- Read the repo's `CLAUDE.md` first: it names existing single-source-of-truth rules and known
  drift (e.g. "provider default has 3 sources", "git spawn adapter"). Findings that extend a
  stated invariant are more valuable than novel ones; findings that contradict one are wrong.

## Ledger + freshness gate (don't rescan the same code with the same model for nothing)
State lives in a committed ledger, `docs/refactoring-scout/ledger.md` (create on first run; same
idea as the safety-net `requirement-extraction` per-module ledger: **the ledger is the loop's
state** — a round that is not logged gets planned again). It holds, per **lane** (a focus area
with a path glob), the last-scanned `sha`, the model, the harvest signals used, the yield
(findings filed / rejected), plus the cumulative **Filed** and **Rejected** lists that double as
the exclusion list for later runs.

Before planning a run, for each candidate lane run the gate:
1. **Drift**: `git diff --stat <lane.sha>..HEAD -- <lane paths>`. Changed files are priority
   targets. Zero drift is NOT proof of completeness (a fresh scout on unchanged code still
   yields — see below), but it removes the strongest reason to rescan.
2. **Reopen triggers** — rescan a lane only if at least one holds: (a) ≥ ~10 changed files or
   ≥ ~5% of the lane since `lane.sha`; (b) a different model (family or generation) than the one
   recorded; (c) a harvest signal not yet used on that lane (the ledger records which of 1–15
   ran); (d) the lane's last yield was still ≥3 filed findings (falling yield with fresh signals
   left is normal; falling yield with the signal pool exhausted means stop); (e) a filed ticket
   from that lane has since been merged (its neighbourhood moved).
3. Otherwise the lane is **saturated for this model at this sha** — say so and either pick an
   unscanned lane, or stop. Report saturation as a *planning* signal, never as "the code is
   clean".
Empirical anchor from this repo (2026-08-16): whole-repo lane, same model, two identical sweeps
overlapped ~40% (7 + 8 findings → 12 tickets); four focused lanes with the exclusion list yielded
31 findings and 1 in-round duplicate. Expect the second focused pass over an unchanged lane to
drop to a third of that or worse.

After a run, append the round (date, model, HEAD sha, lanes, signals used, tickets filed with
titles, rejected list with reasons) and update each lane's row. Commit the ledger with the run.

### The target moves — this is NOT the extraction ledger's world
`requirement-extraction` can afford "converge a module, then leave it": its code changes slowly.
This repo changes daily, and the scout's own tickets landing is itself drift (a merged #5xx
deletes copies and can invalidate a sibling finding's evidence). Consequences:
- **Convergence is always `converged at <sha> for <model>`**, never "done". A saturated lane
  reopens automatically when the drift gate trips; don't record saturation with a date-based
  expiry, record it with the sha it was measured against.
- **Default cadence is drift-scoped, not sweep-scoped.** When drift since `lane.sha` is small
  (< the reopen threshold) but non-zero, don't rescan the lane — run a **diff-scoped scout**: the
  changed files + their direct importers/importees, all 15 signals, exclusion list applied. New
  code is where new workarounds appear (a fresh feature usually copies the nearest existing
  pattern, drift and all). Full-lane rescans are for large drift, a new model, or an unused signal.
- **Ticket-freshness pass before each run** (cheap, do it first): for every OPEN scout ticket in
  the lane, `git diff --stat <ticket-filed-sha>..HEAD -- <files it cites>`. Untouched → still
  valid. Touched → re-verify 2 cited sites: if the workaround is gone (fixed incidentally or by a
  sibling ticket) close the ticket with a note; if it moved, refresh the file:line evidence in a
  comment; if partly fixed, narrow it. A ticket whose evidence has rotted is worse than none — a
  builder will chase line numbers that no longer exist. Record the pass in the round entry.
- **Track yield-per-drift, not yield-per-run.** A lane with high drift and low yield means the
  code being written there is clean — lower its cadence. A lane with low drift and high yield
  means the previous scan was shallow — that lane deserves an unused signal, not another sweep.
- **Two clocks in the ledger**: `lane.sha` (last full scan) and `lane.diffSha` (last diff-scoped
  scan). The reopen gate compares against `lane.sha`; the diff-scoped run starts from
  `lane.diffSha ?? lane.sha` and advances only `diffSha`.

## Running as a fleet (caller's playbook)
One scout over a ~1400-file repo saturates at ~7 findings and two identical sweeps overlap
~40%. To go deeper: give each scout a **distinct lane** (e.g. server services / client /
mcp+cli+routes / shared+startup+repositories; later rounds: startup exit-workflow +
session-manager / plugin+worker+service-stack subsystems / test-seam smells / cross-package
types & DTO contracts), pass the exclusion file, and let scouts REPORT ONLY — the caller
dedupes across lanes (merge same-idea findings, keep both evidence lists) and files. Focused
lanes with an exclusion list produced ~0 cross-round duplicates and ~1 in-round duplicate per
4 scouts. Ask each scout to also return **skill feedback** (which steps helped, which were
wasted, what signal it wished it had) — fold it back into this file after each round.

## Step 1 — Harvest signals (cheap, mechanical, do all of them)
Run these over `packages/*/src` (exclude `__tests__`, `dist`, generated `drizzle/`), noting
file:line for each hit. Don't read whole files yet — collect a candidate list.

1. **Marker comments**: `workaround|hack|kludge|band-?aid|for now|temporar|FIXME|XXX|legacy|
   back-?compat|backwards|special.?case|edge.?case|until we|because .* (windows|vitest|drizzle|sqlite)`.
   Cluster hits by directory — 5 hits in one module = one finding, not five.
2. **Type-sniffing / string-sniffing**: `typeof x === 'string'`, `'x' in obj`, `startsWith(`,
   `includes('` on identifiers, `as any`, `as unknown as`, `// @ts-` — each is often a missing
   discriminated union or a missing narrow helper.
3. **Repeated guard chains**: the same 2–4-clause `if (a && !b && c !== 'x')` in ≥3 files
   (grep a distinctive clause, then look for siblings). Candidate for one predicate function.
4. **Copy-drifted helpers**: functions with the same/similar name in ≥2 packages or ≥2 dirs
   (`grep -rn "^export (async )?function <name>"` for names appearing >1×; also `normalize*`,
   `parse*`, `resolve*`, `is*`, `to*`, `format*`). Diff them — drift = latent bug + finding.
5. **Enum-by-if**: `switch`/`if-else` over the same string literal set in ≥3 places (providers,
   placements, statuses, columns, view names, stack kinds). Candidate for a traits table /
   registry so the next member is one entry.
6. **Flag soup**: functions with ≥3 boolean params or an options bag where callers pass
   mutually exclusive combos — usually a missing mode enum or a missing strategy object.
7. **Re-derivation**: the same value computed from raw inputs at multiple layers (paths from
   repoPath+branch, ports from issue numbers, keys from slug+id, pref names from
   `<prefix>_<projectId>`). Candidate for one keyed constructor function.
8. **Ad-hoc persistence**: JSON blobs in string columns, sentinel files, prefs used as tables
   (`pref_<thing>_<id>` families). Note when a family has grown past ~4 members.
9. **Test smells that point at production shape**: tests that mock 5+ modules, `vi.mock` of the
   same module in ≥10 test files, or helper factories duplicated across test dirs → the
   production seam is missing, not the test.
10. **Layer copies**: the same logic in REST route + MCP tool + CLI command (this repo has three
    entry surfaces). Sample 5 operations and check whether they share a service function.
11. **SSOT declared but bypassed** (the highest-yield signal so far — ~30% of all findings):
    grep for self-declared authorities — `single source of truth|the one parser|all callers must|
    canonical|SSOT|so .* can never .* drift|previously open-coded` — and for each, count
    IMPORTERS of the helper vs. RAW re-implementations of what it does. A helper with 1–3
    importers next to 10+ hand-rolled copies is a finished abstraction nobody adopted; the
    finding is "route the copies through it", which is the cheapest kind.
12. **Existing helper, low adoption**: same idea without a comment — for each exported
    `resolve*/parse*/is*/build*` in `shared/lib`, compare importer count with the grep count of
    the pattern it encapsulates (e.g. `strategyPrefKey` had 3 importers vs 11 inline templates).
13. **Positional-param relays**: functions with ≥8 params whose signature is re-typed at ≥2
    layers and forwarded positionally — a missing request object; usually accompanied by
    duplicated "prep" pipelines in each implementation.
14. **Lifecycle boilerplate**: module-level `setTimeout+setInterval+stop()` scheduler blocks;
    React `useEffect` bodies that only wire `addEventListener`/`setInterval`/`CustomEvent`
    subscriptions; `let cancelled=false` fetch ladders. Count copies; a hook/helper of ~20
    lines usually deletes 100+.
15. **Sentinel values decoded unevenly**: a magic value (`"HEAD"`, `""`, `"none"`, `null`-as-
    tristate) that SOME callees special-case and others don't — grep the literal, list callees.

## Step 2 — Qualify each candidate (read the actual code)
For each cluster from Step 1 read the real files. Keep only findings that pass ALL of:
- **Concrete**: you can name the files and the shape of the abstraction (a signature, a table
  shape, a module name). "Consider cleaning up X" is not a finding.
- **Minimal**: the abstraction is ≤ ~1 file / one function / one type / one table; the change
  is measured in hours-to-a-day, not weeks.
- **Net-negative code or net-positive extensibility**: either it deletes more than it adds, or
  it turns a known upcoming extension into a local change. Say which, with a rough line delta.
- **Not already covered**: check `CLAUDE.md`, `BACKLOG.md`, `docs/decisions/`, and the open
  board tickets (`mcp__agentic-kanban__list_issues` filtered by title keywords) for the same
  idea. If it exists, skip or reference the existing ticket number instead of refiling.
- **Verified**: at least one claim per finding was checked by reading code, not inferred from
  a grep. Say what you verified.

Drop findings that are really *bugs* (file them as bugs separately if severe) or really
*rewrites*. Prefer 5 sharp findings over 15 vague ones.

## Step 3 — Rank
Score each 1–5 on **Payoff** (lines deleted, drift removed, extension unblocked) and 1–5 on
**Cheapness** (small, low-risk, well-tested area). Rank by Payoff × Cheapness. Break ties in
favor of findings that align with an invariant already stated in `CLAUDE.md`, then in favor
of findings whose evidence includes a VERIFIED behavioural drift (two copies that disagree).
If a finding carries a **latent bug** (a copy that is simply wrong today — e.g. a ternary that
routes copilot to claude), say `Carries latent bug:` explicitly so the caller can split a bug
ticket; don't let it silently ride inside a refactor. If two findings touch the same signatures,
state the order (`Do AFTER <other>`).

## Step 4 — Report + file tickets
Produce this table first (it is what a reviewer scans):

| # | Title | Files (count) | Shape of the abstraction | Δ lines (est) | Payoff | Cheapness |

Then one section per finding:

```
### <Title>
**Workaround today**: what the code does now, with file:line evidence (≥2 sites).
**Minimal abstraction**: name + signature/shape; where it lives; who calls it.
**Why it pays**: deleted duplication / removed drift / extension prepared (name the extension).
**Verified**: what you actually read/ran to confirm this is real, not a grep artifact.
**Out of scope**: what a tempted implementer should NOT do (the rewrite trap).
**Related**: existing tickets/decisions, if any.
```

File every finding that survives Step 2 as a kanban ticket with `mcp__agentic-kanban__create_issue`,
**always passing `projectId` explicitly** for the project whose code you scouted (for this
repo: agentic-kanban, id `d1c5d9c1-4897-4e1b-acc3-2aa96de04117`). If the board MCP is not
connected in the session, use REST against the running server — `POST /api/issues` with
`{projectId, title, description, priority, issueType: "chore", statusId: <Backlog id from
GET /api/projects/:id/statuses>}` — rather than `pnpm cli -- issue create`: the CLI may open a
home-fallback DB (it prints a `[db] ... home-fallback` / "IGNORING ... stub" warning) and file
into a board the server never shows. Title format:
`refactor: <verb> <thing> — <the abstraction>` (e.g. `refactor: collapse 6 pref-key builders — prefKey(name, projectId)`).
Body = the finding section verbatim plus a `Source: refactoring-scout run <date>` line.
Priority: rank 1–2 → `high`, others → `medium`. Tag with `refactoring` if labels are supported.
Before filing, dedupe against tickets filed by other scouts in the same session (search by
title keyword) — merge, don't duplicate; if a duplicate exists, add your extra evidence as a
comment instead of a new ticket.

Finish by returning the ranked table plus the created ticket numbers.

## Anti-patterns for this skill
- Filing "extract a service layer" or "introduce DI" — too big; not a minimal abstraction.
- Counting grep hits as findings without reading them.
- Reporting a workaround that exists *because of* a real constraint (Windows, sqlite, vitest 4)
  as removable — those are candidates for a *named* helper that documents the constraint, not
  for deletion. Say so.
- Touching test-only duplication unless it reveals a missing production seam.

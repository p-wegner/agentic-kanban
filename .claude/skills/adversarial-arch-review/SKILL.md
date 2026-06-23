---
name: adversarial-arch-review
description: Adversarial, code-metrics-driven architecture review. Distrust the codebase's own self-assessment (memory, "DONE/COMPLETE" notes, comments), use churn/complexity/coupling metrics to TARGET where to dig and to INFER structural problems, verify the most damning findings directly before relaying, and answer three questions — what architecture decisions truly limit future work, what dependencies (internal + external) are risky, what code is concerning. Use for "adversarial architecture review", "be critical about the architecture", "what's truly limiting us", "metrics-based code health audit", "where are the real risks".
argument-hint: "[optional: focus area, package, or 'file tickets']"
---

# adversarial-arch-review

A **critical** architecture review that assumes the codebase (and its own documentation) is lying to you until proven otherwise. Distinct from `architecture-review` (generic, dimension-based, trusting) and `architecture-improvement` (forward-looking plan). This one is **adversarial and evidence-first**: metrics point the flashlight, parallel agents dig, and you personally verify the worst claims before they reach the user.

Output goal — answer three questions concretely, ranked by severity, every finding carrying `file:line` evidence:
1. **What architecture decisions truly limit future implementation?** (not cosmetic debt — things that make the *next* feature expensive)
2. **What dependencies are risky?** — internal (forks, drift, single-source-of-truth lies) AND external (unpinned/pre-1.0 deps, off-PATH CLIs, undocumented wire formats)
3. **What code is concerning?** (latent bugs, data-integrity holes, fragility)

`$ARGUMENTS` = optional focus (a package, a subsystem) or `file tickets` to also create backlog items at the end.

---

## The adversarial stance (read first — this is the whole point)

- **Distrust self-congratulation.** Memory files, `CLAUDE.md`, and commit messages full of "DONE / COMPLETE / exhausted / single source of truth" are **claims to verify, not facts**. The codebase most wants you to believe it's already fixed exactly where it isn't.
- **Comments lie about intent, not behavior.** A doc comment saying "FKs are RESTRICT in the live DB" is a *belief*; check whether the DB actually enforces it.
- **Gates get gamed.** A "no file >1000 lines" gate produces 971-line files, not cohesive ones. A "single source of truth" claim coexists with N forked copies. Look for the gaming, not just the gate.
- **Verify the damning, cheap claims yourself.** Before you tell the user "FK enforcement is off" or "there's an orphaned migration", run the 1-command check. A subagent's confident prose is a lead, not a verdict.
- **Severity is about the future, not the line count.** A tidy 80-line config module can be the worst liability in the repo if a single logical setting is read from 8 places.

---

## Step 0 — Get metrics (they tell you WHERE to dig)

Use the `code-metrics` skill. Reuse a fresh `code-metrics-out/analysis.json` + `report.md` if one exists (check its mtime); else run analyze:

```
<skill-repo>/.venv/Scripts/code-metrics.exe analyze <repo> --days 90
```

Then read `code-metrics-out/report.md` — specifically the **Executive Summary**, **Risk Overview (Top 30)**, and the **Refactor First** sections. You are mining it for *signals to interpret*, not a to-do list.

### Reading metrics adversarially — infer architecture from numbers

The metrics don't tell you the architecture problem; they tell you where it hides. Inferences that have paid off:

| Signal in the report | Architectural inference to chase |
|---|---|
| One file with **extreme churn** (e.g. 700+ commits, 10×/day) | **God-container / central fan-in-out hub** — every feature must touch it. "Decomposition" that didn't drop its churn was cosmetic (lines moved, centrality kept). |
| A **cluster of files just under a size gate** (971, 964, 948…) | **Metric-gaming** — files split to clear the threshold, not for cohesion. |
| **High max-CC in a single function** (40+) | A decision/parsing/state-machine knot — usually an untyped boundary (parsing external output, config coercion). |
| **High temporal coupling** between files that aren't statically linked | A hidden contract / fork that must change in lockstep (the "single source of truth" is a lie). |
| **Author dominance 90%+ everywhere** + young age + huge churn | Codebase written largely by **automated agents**; expect convention-over-structure and gates-as-architecture. |
| **High fanout** on a service | Leaky abstraction depending on many concretes. |

Form **hypotheses** from these, then assign them to deep-dive agents.

---

## Step 1 — Fan out adversarial deep-dives (parallel)

Pick the 4–6 highest-suspicion areas (metric-driven + the usual structural liability hotspots) and dispatch one `general-purpose` agent each, IN PARALLEL (one message, multiple tool calls). Use `general-purpose`, not `Explore` — you need reasoning and judgment, not just file-location.

The recurring liability areas worth a dedicated agent (adapt to the stack):
- **Configuration / settings** — flat untyped key/value blobs, multiple sources of truth for one logical setting, drift, precedence duplicated per consumer. (Often the worst liability; the project will have *patches over* the drift — divergence detectors, "one-switch" helpers — which are themselves the tell.)
- **External-dependency seam** — how external tools/CLIs/SDKs are invoked and their output parsed; version pinning; brittleness to upstream format changes; server/client parser forks.
- **Persistence / data integrity** — schema vs live DB drift, FK enforcement, hand-rolled cascades, transactions around multi-resource writes, migration management.
- **The "refactor campaign" audit** — did the recent `refactor(arch)` commits improve cohesion or game the gates? Read the facades/barrels; check the gate config for grandfather/exception lists; check for threshold-hugging.
- **Front-end topology** (if applicable) — god-containers, prop-drilling hubs, absence of a data-fetching/cache layer, real-time strategy fragmentation.
- **The churn champions** — whatever the metrics flagged that the above don't cover.

**Agent brief template** (fill the brackets):
> You are doing an ADVERSARIAL architecture review of [repo]. Focus ONLY on [area]. Be skeptical — the codebase's own memory/comments claim this is "done"; verify. Investigate [specific files], cite file:line. [3–5 pointed questions, seeded with the metric signal and any suspicious self-claim to disprove.] Report the 5–8 most concerning findings ranked by severity, each with file:line evidence and WHY it limits future implementation or is risky; distinguish latent bug from design smell. Diagnosis, not fixes. Keep tight.

Seed each brief with the specific self-claim to disprove (e.g. "memory says X is single-source — find the forks") — adversarial framing produces sharper findings than neutral framing.

---

## Step 2 — Verify the worst claims YOURSELF (do not relay unverified)

For every **CRITICAL/HIGH** finding that is (a) damning and (b) cheap to check, run the direct check before it reaches the user. This is non-negotiable — it's what separates this skill from "I asked some agents." Examples of cheap killers:

- "FK enforcement is off" → grep for `PRAGMA foreign_keys` / the connection setup; confirm it's never set.
- "There's an orphaned/duplicate migration" → `ls` the migrations dir + grep the journal for the tag.
- "X is parsed in two places" → open both and diff the field handling.
- "The gate has a grandfather list" → open the gate config and count exceptions.
- "No version pinning" → grep the manifests for the dep ranges.

Label each finding **VERIFIED** (you confirmed it) vs **REPORTED** (agent evidence, spot-checked but not exhaustively re-run) in the writeup. Be honest about the gap.

---

## Step 3 — Synthesize

Write a tight, prioritized report. Structure that has worked:

1. **A meta-finding that frames everything** — the one structural truth that explains the rest (e.g. "this codebase is refactored by the agents it runs, so machine-checked gates are good and everything held by convention has rotted"). The metrics usually hand you this.
2. **Truly limiting decisions** (the §1 question) — 2–4 of them, each: the decision, the evidence, why it taxes every future change.
3. **Risky dependencies** (§2) — internal forks/drift + external version/contract exposure, with the specific failure mode each invites.
4. **Most concerning code** (§3) — latent bugs and integrity holes.
5. **What's genuinely good** — be fair; name the gates/patterns that actually work. Credibility comes from praising what deserves it and flagging which "done" claims are oversold.
6. **Priorities** — highest-leverage first, with the throughline (often: "machine-enforce the invariants that currently live in prose").

Severity rubric: **CRITICAL** = data loss / silent corruption / every-launch breakage. **HIGH** = taxes every future change in a hot area, or a latent bug waiting on the right input. **MEDIUM** = real smell, contained. **LOW** = cleanup.

---

## Step 4 — File tickets (only if asked: `file tickets` / "create backlog items")

Group findings into well-scoped tickets (one per fix, CRITICAL→LOW). Each description: the finding, `file:line` evidence, the consequence, and a one-line action. Prefix titles (e.g. `[arch-review] …`) so the batch is identifiable.

**GOTCHA (learned the hard way) — do NOT use `pnpm cli -- issue create` blindly:**
- The CLI files into the **active project**, resolved from the `activeProjectId` pref. That pref is often **unset**, so it falls back to whatever project is "most recently active" — which may be a *different* project the board is currently driving. Filing there is wrong, AND the board's monitor may **auto-launch an agent** on your new ticket (it tried to "fix" this repo's DB code inside a Pong project).
- **Always file via REST with an explicit `projectId`**, into **Backlog** (not Todo, which can auto-start), with `skipAutoReview:true`:
  - Get the id: `curl -s http://localhost:3001/api/projects` → match by name.
  - Get the Backlog status id: `curl -s http://localhost:3001/api/projects/<pid>/statuses`.
  - POST each: `{ "projectId":"<pid>", "title":"…", "description":"…", "issueType":"bug|chore|feature", "priority":"critical|high|medium|low", "statusId":"<backlog>", "skipAutoReview":true }` to `POST /api/issues`. A small Python/Node loop (urllib) avoids shell-quoting hell with multi-line descriptions; delete the temp script after.
- **Verify after**: confirm `0 active workspaces / 0 running sessions` for the target project (nothing auto-launched), and that you did NOT change `activeProjectId`.
- If you misfile + something auto-launches: `DELETE /api/workspaces/<id>` (cascades the session) then `DELETE /api/issues/<id>`, and re-file correctly.

Don't file tickets unless the user asked — the default deliverable is the diagnosis.

---

## Anti-patterns (don't do these)

- Relaying a subagent's CRITICAL claim without the cheap direct check.
- Treating the metrics report as a refactor to-do list instead of a map of where to investigate.
- Trusting "DONE/COMPLETE" in memory or comments.
- Listing every CC>10 function — that's noise; per-function CC is often a false positive. Tie findings to *architectural consequence*.
- Proposing fixes at length. This skill diagnoses; fixes are a separate task (and tickets capture the action in one line).

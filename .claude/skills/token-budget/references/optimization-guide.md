# Reducing token count without losing performance

Guidance the skill applies when asked to shrink a doc, prompt, CLAUDE.md, or
agent skill. **Rule zero: never trade tokens for behavior.** Every load-bearing
instruction, constraint, selector, path, or example that changes model output
must survive. Cut noise, not signal. After every pass, re-count and report the
delta, and confirm semantics are intact.

## What is safe to cut (high value, low risk)
- **Filler / hedging:** "in order to" → "to"; drop "it's worth noting that",
  "basically", "simply", "please note". Wordiness, not meaning.
- **Restating:** the same instruction said two ways, or a summary that repeats a
  list right above it. Keep one canonical phrasing.
- **Redundant examples:** if three examples teach the same rule, keep the
  clearest one (keep diversity when each example covers a *distinct* case).
- **Dead context:** outdated notes, resolved TODOs, "we used to…" history that no
  longer affects behavior.
- **Over-structuring:** many tiny sections/headings add scaffolding tokens; merge
  closely related ones.
- **Verbose tables/lists:** trim columns that restate, collapse obvious rows.

## What to preserve (do NOT cut)
- Exact identifiers: file paths, function/selector names, flags, model IDs, ports.
- Constraints and negatives ("never do X", "must run before Y") — these are
  high-signal and easy to lose in a rewrite.
- One concrete example per distinct behavior.
- Domain/edge-case warnings learned the hard way.

## Method
1. **Baseline:** `tokt scan` / `tokt count` the target; record total.
2. **Locate bloat:** `tokt audit <file>` for candidate hotspots.
3. **Rewrite conservatively:** apply the safe-to-cut list; keep a diff.
4. **Re-count + report:** `tokt count` before vs after → tokens saved + %.
5. **Verify behavior unchanged:** re-read for dropped constraints; if the doc
   drives an agent, sanity-check the agent still has what it needs.

## Rules of thumb
- Tighten prose first (cheapest wins), restructure second, cut content last.
- Prefer one strong example over three weak ones.
- A table is cheaper than the same data as prose paragraphs — but only if every
  cell carries signal.
- Aim for the smallest text that produces the same model behavior, not the
  smallest text.

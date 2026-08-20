# Ideas: Agent Health & Failure Observability

*2026-07-07 — brainstorm. Theme: Insights shows cost/tokens/success AFTER the fact; nothing watches a session's health WHILE it runs, and failure knowledge lives in humans' heads / CLAUDE.md instead of the product.*

## What exists today
- Insights view (cost, tokens, success rate, P50/P95 by skill/model), Agents view (live sessions), live context-token count on cards, session transcripts persisted, Digest view, `monitor-nudge` after 5 min, stale-session cleanup on boot.
- Tribal knowledge encoded only in docs: "~1 s transcript with zero tokens = launch failed", "`git rebase --no-edit` fails ~5×/window", "PowerShell is the worst-failing tool at ~17%".

## Idea 1: Agent Vitals — live per-session health classification
Compute a rolling health state from the event stream the server already parses (stream-json):

| Signal | Detects |
|---|---|
| tokens/min ≈ 0 after launch | dead/failed launch (the "1-second session") |
| same tool + same error ≥3× | error loop (the rebase `--no-edit` pattern) |
| high token burn, zero file edits for N min | thrashing / lost agent |
| tool-error rate over trailing window | degraded session |
| context tokens > 80% of window | imminent compaction risk on a delicate task |

Surface as a vitals dot on cards (green/amber/red) + a reason string ("looping on `git rebase`"). The monitor/Conductor consumes the same classification instead of re-deriving staleness heuristics each cycle — today every monitor cycle re-infers health from scratch with an LLM.

**Escalation policy per state**: red-loop → auto-inject a corrective nudge (a targeted `monitor-nudge` variant naming the loop); dead-launch → auto-stop + relaunch once; still red → attention queue (see attention-queue.md). This turns the CLAUDE.md "in-flight workspace recovery" prose into product behavior.

## Idea 2: Flight Recorder — condensed causal timeline per issue
"Why did #212 take 4 cycles?" is currently answerable only by reading transcripts. Record the *macro events* the system already emits into one timeline per issue: launched → 3 tool-error bursts → review round 1 (2 findings) → auto-fix → review round 2 → conflict on rebase → reconciled → merged → canary green.

- Render in the issue detail panel; feed the Digest ("#212 needed 2 review rounds and a conflict resolve").
- This is aggregation of existing rows (sessions, messages, review results, workspace state transitions), not new instrumentation — mostly a query + a component.

## Idea 3: Friction Ledger — fleet-level failure aggregation, in-app
The `fleet-analysis` / `learning-step` skills do this out-of-band today. Productize the *collection*: every tool error (name, exit code, first line of stderr, provider) is bucketed into a `tool_friction` table as sessions run.

- New Insights section: **Top failing commands this week** ("`git rebase --no-edit` — 23 failures across 9 sessions"), trending vs. last week.
- Each bucket has a **"Forge fix" button** that launches a Smith-style workspace pre-loaded with the bucket's examples, whose job is a hook/skill/CLAUDE.md patch. The compounding loop becomes one click instead of a ritual.
- This is the observability feature with the highest compounding return: it makes the board *measure its own agent-UX* and fix it.

## Idea 4: Provider scorecard
Insights already splits by model; split by **provider/profile** too (Claude vs Codex vs Copilot vs Pi) on success rate, cost/ticket, review-findings-per-diff, fix-rounds-to-merge. The Strategy Bullseye picks providers today on vibes; give it data. Auto-annotate the Bullseye UI: "Codex: 71% first-review pass vs Claude 84% on this repo".

## Idea 5: Token/cost budgets with runaway kill
Per-workspace (and per-monitor-cycle) budget: soft limit → nudge injected ("wrap up, summarize state to the ticket"); hard limit → stop session, post state to the attention queue. Insights has all the numbers; nothing enforces them mid-flight. A runaway $40 session should be structurally impossible, not just visible afterwards in Top-10-expensive.

## Priority
Idea 1 (vitals) unblocks everything else the monitors do; Idea 3 (friction ledger) has the best long-term ROI.

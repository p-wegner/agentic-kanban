# Ideas: Verification as a First-Class Gate (not just review)

*2026-07-07 — brainstorm. Theme: the board reviews diffs, but nothing **proves behavior**. For true hands-off operation, "merged" must mean "demonstrated working", not "an LLM read the diff and liked it".*

## What exists today
- AI code review on session exit (`review_auto_fix`), PR Quality Score badge, "Visual verification timing" setting (before/after merge), `needs-visual-verification` tag, skip-review flag.
- All of these are *opinions about the diff*. None execute the change and observe it.

## Idea 1: Machine-checkable acceptance criteria ("Acceptance Harness")
A ticket can carry structured, executable acceptance checks alongside its prose description:

```yaml
accept:
  - run: pnpm exec vitest related packages/server/src/routes/digest.ts
    expect: exit 0
  - run: curl -s localhost:$PORT/api/digest?range=24h
    expect: jsonpath $.created >= 0
  - browser: open /board, click "Digest" tab, screenshot
    expect: agent-judged "shows KPI cards"
```

- Authored by the ticket-enhancer / Decompose step (AI drafts them, human can edit) — cheap because enhancement already exists.
- The workspace pipeline gains a **Verify stage** between Review and Merge (fits the existing Workflow DAG — a built-in "Verified Ticket" workflow). Checks run *in the worktree* on its ports.
- A check failure blocks merge and is fed back to the agent as a `/turn` with the failing output — same loop as `review_auto_fix`, but grounded in execution instead of opinion.
- Why it matters: this converts "the agent says it's done" into "the board observed it working", which is the single biggest trust upgrade for auto-merge.

## Idea 2: Evidence Ledger per workspace
Every workspace accumulates **evidence artifacts**: test-run outputs, typecheck results, playwright screenshots, curl transcripts, quality-score snapshots — each stamped with commit SHA + timestamp.

- Shown as a checklist strip on the workspace panel and card ("✅ tests · ✅ typecheck · 📸 UI · ⬜ acceptance").
- Auto-merge policy becomes *evidence-based*: "auto-merge only if evidence ≥ {tests, typecheck}" instead of a global boolean.
- Agents already produce this output in transcripts; the ledger just requires them (via a `record_evidence` MCP tool + skill instruction) to register it, so it's queryable instead of buried in session JSONL.

## Idea 3: Master canary + auto-bisect-to-workspace
After every merge, run the project's fast check suite (`test:mine`, typecheck) on the base branch headlessly.

- Red canary → the board *knows which merge did it* (it just merged it) → auto-file a bug ticket linked `blocked_by`-style to the offending issue, optionally auto-launch a fix workspace pinned to that regression.
- Closes the biggest hands-off hole today: two individually-green branches merging into a broken master with nobody watching.
- Cheap v1: it's a scheduled run (feature exists) with a diff-aware trigger; the delta is attribution + auto-ticketing.

## Idea 4: Flaky-radar integration for the gates
The Flaky Tests Radar already ingests pass/fail history. Wire it into the Verify stage: a failing check that matches a known-flaky test gets **one auto-retry and a "flaky-excused" evidence entry** instead of blocking merge or burning an agent fix-cycle. (Today the flaky knowledge exists but no gate consults it — the `flaky-test-triage` skill is manual.)

## Priority
Idea 3 (canary) is the highest leverage per line of code. Idea 1 is the biggest conceptual upgrade. Idea 2 is the substrate both want.

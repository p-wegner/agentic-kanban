# Existing-test audit — safe retirement of low-value tests

Coverage improves by deletion as well as addition. coverage-intelligence flags candidates in
`_gaps.md` (audit list); this is how to action them safely. **Never delete a test before
confirming the behaviour it covered is covered elsewhere** — check `_coverage.json`.

## The five problems and their dispositions

| Problem | Signal | Disposition |
|---------|--------|-------------|
| **obsolete** | exercises behaviour with no matching entry in `_behavior-model.json` (feature removed) | DELETE — after confirming the behaviour is truly gone (grep the code), not just renamed |
| **duplicate** | same behaviour + same dimensions as another test | MERGE into the stronger one (keep the better assertions); delete the weaker. Name the survivor |
| **low-value** | passes without asserting anything observable (smoke-only, `expect(true)`, renders-without-crashing) | UPGRADE to assert the outcome if the behaviour matters; else DELETE |
| **implementation-coupled** | asserts internal state / brittle selectors / volatile copy; breaks on safe refactors | DE-COUPLE: rewrite assertions to target the observable outcome with stable selectors. Don't delete coverage, fix it |
| **flaky** | on known-flaky list or intermittent in history | STABILIZE: replace sleeps with condition waits, scope selectors, add cleanup/unique suffixes. Only quarantine (never silent `skip`) if the underlying behaviour is itself non-deterministic — and file that as a finding |

## Rules
- **Confirm before you cut.** A test that looks low-value may be the only thing asserting a real
  behaviour. Cross-check `_coverage.json`: if removing it would flip a behaviour to `uncovered`,
  upgrade instead of delete.
- **Prefer fix over delete** for coupled/flaky — the coverage intent is usually valid, the
  execution is wrong.
- **Record every change** in `_authored.json` (as `action: delete|merge|decouple|stabilize`) and
  update `_coverage.json` so the matrix reflects reality (a merged/deleted test's `covered_by`
  entries move or drop).
- **Scope discipline** (project rule): a test-cleanup pass touches tests and the verification
  model — not product code. If de-coupling a test reveals a product bug, file a ticket, don't fix
  it inline.
- Re-run the affected suite after any edit; a "cleanup" that reds the suite is not cleanup.

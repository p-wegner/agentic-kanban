/**
 * Neutralise the AMBIENT `%TEMP%` health read for unit tests (#1056).
 *
 * `runPreMergeGate` refuses to start a verify chain on a box whose `%TEMP%` is too big or too
 * slow (`probeTempHealth` → `decideGateHostAdmission`). That is correct in production and it is
 * the whole point of the ticket — but it makes ~31 unit tests of what the gate does DOWNSTREAM
 * depend on the developer's own temp directory, which is state no test controls and every test
 * shares. Measured while this was written: 100,595 entries on the authoring machine, enough to
 * turn all of them red for a reason having nothing to do with the code under test.
 *
 * Raising the cap here is the same move `gate-builder-quiesce.test.ts` makes with
 * `SMART_HOOKS_MIN_FREE_GB` for the memory floor, and for the same reason. It does not weaken
 * the check: `probeTempHealth` is covered directly against fixture directories it controls
 * (`packages/server/src/__tests__/temp-health.test.ts`), and the admission DECISION is covered
 * purely (`gate-host-admission.test.ts`). What is switched off is only the ambient read.
 *
 * Not forced: an explicit value from the environment wins, so a test or an operator that WANTS
 * to exercise the hold can still set it.
 */
if (process.env.KANBAN_TEMP_ENTRY_CAP === undefined) {
  process.env.KANBAN_TEMP_ENTRY_CAP = String(Number.MAX_SAFE_INTEGER);
}
if (process.env.KANBAN_TEMP_PROBE_BUDGET_MS === undefined) {
  // The time bound is the other half: a slow enumeration must not red the suite either.
  process.env.KANBAN_TEMP_PROBE_BUDGET_MS = String(10 * 60_000);
}

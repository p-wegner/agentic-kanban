/**
 * Serialization of plugin-loop advances — #249.
 *
 * One in-flight advance per (project, plugin, loop).
 *
 * The dedupe inside an advance is read-then-create (`listPluginLoopIssues` → `byKey.get` →
 * `createIssue`) and `issues.external_key` carries no unique index, so two overlapping advances
 * of the SAME loop both see "not ticketed yet" and both create a ticket for the same unit. The
 * window is not narrow: the planner may run for up to two minutes between the read and the write.
 * And two callers genuinely race — the monitor's `plugin-loops` phase is serialized only against
 * ITSELF (`cycleRunning`), not against `POST /api/plugins/:id/loops/:name/advance`.
 *
 * So advances of one loop are QUEUED rather than rejected: the second caller runs after the
 * first, re-reads the tickets the first created, and reports those units as `skippedExisting` —
 * which is exactly what a repeat advance is supposed to do.
 *
 * MODULE-LEVEL ON PURPOSE. The plugin service is rebuilt whenever it gains a dep
 * (`getPluginService`), so a closure-scoped map would silently stop serializing at that point.
 * That is also why this lives in its own module rather than inside the engine factory.
 *
 * NOT a substitute for a DB constraint. A partial unique index on `external_key` would also
 * cover a second board process against one database; this covers the real deployment (one
 * server process owns the DB) and is what makes the invariant testable.
 */

const advanceQueues = new Map<string, Promise<unknown>>();

/**
 * The lock key. Derived rather than spelled at each call site: `advanceLoop` and `resolveGate`
 * both take this lock, and a gate resolve mutates exactly the state the planner reads, so the
 * two must agree on the key or the serialization silently covers only half the callers.
 */
export function loopAdvanceLockKey(projectId: string, pluginSlug: string, loopName: string): string {
  return `${projectId}:${pluginSlug}:${loopName}`;
}

export async function withLoopAdvanceLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prior = advanceQueues.get(key) ?? Promise.resolve();
  // `then(run, run)`: a failed advance must not wedge the queue for the next caller.
  const attempt = prior.then(run, run);
  const tail = attempt.then(() => undefined, () => undefined);
  advanceQueues.set(key, tail);
  try {
    return await attempt;
  } finally {
    if (advanceQueues.get(key) === tail) advanceQueues.delete(key);
  }
}

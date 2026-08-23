/**
 * `firstRow` — the one spelling for "run this query, give me its single row or null".
 *
 * The repository layer had written that out by hand ~80 times as
 *
 * ```ts
 * const rows = await database.select().from(t).where(...).limit(1);
 * return rows[0] ?? null;
 * ```
 *
 * and the spelling had already started to drift (`pref.length === 0 ? null : pref[0].value`
 * in `board-status.repository.ts`, a raw one-element array returned from
 * `scheduled-run-query.repository.ts` that every caller then indexes). #772 collapses the
 * mechanical form onto this helper so there is one thing to read and one thing to change.
 *
 * Deliberately typed against `PromiseLike<T[]>` rather than a Drizzle builder type: it is a
 * pure array utility with no ORM import, so it is safe from the shared barrel and from any
 * package, and it works just as well over a plain `Promise<T[]>` in a test.
 */
export async function firstRow<T>(query: PromiseLike<T[]>): Promise<T | null> {
  const rows = await query;
  return rows[0] ?? null;
}

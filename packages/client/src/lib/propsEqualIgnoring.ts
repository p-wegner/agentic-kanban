/**
 * Shallow prop comparison for a `React.memo` comparator, with an explicit set of keys
 * that are deliberately NOT compared.
 *
 * Extracted from `IssueCard.tsx` (#796): the rule carries a non-obvious safety argument
 * — retaining a stale handler is only sound because handlers are ignored *and* every
 * other prop is compared — and nothing verified it while it lived inside the component.
 *
 * Two properties this must keep, both easy to lose in an edit and both covered by the
 * companion test:
 *  - the key set is the UNION of both objects' own keys, so a prop appearing or
 *    disappearing between renders is a difference rather than being skipped;
 *  - comparison is `Object.is`, so `NaN` equals itself and `+0`/`-0` do not.
 */
export function arePropsEqualIgnoring<P extends object>(
  prev: P,
  next: P,
  ignoredKeys: ReadonlySet<keyof P>,
): boolean {
  const keys = new Set<keyof P>([
    ...(Object.keys(prev) as (keyof P)[]),
    ...(Object.keys(next) as (keyof P)[]),
  ]);
  for (const key of keys) {
    if (ignoredKeys.has(key)) continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  return true;
}

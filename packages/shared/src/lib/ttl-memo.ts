/**
 * One short-TTL memo, instead of eleven hand-rolled ones (#559).
 *
 * The same shape was written out across server, shared and client: a `Map` of
 * `{value, at}`, a `Date.now() - at < TTL` read, and — in several — a bespoke
 * `__resetXForTests()` export existing only because the state is module-global and one
 * suite's entries would otherwise leak into the next.
 *
 * The duplication is not the cost. The cost is that each copy decides independently whether
 * it is clock-injectable, and most were not — so testing a TTL boundary meant either
 * sleeping or exporting another reset hook. This one is injectable by construction.
 *
 * **The memo is the container, not the policy.** Deliberately NOT modelled here:
 * `workspace-summary-cache`'s stale-while-revalidate semantics and `git-exec`'s dedupe-key
 * rules. Both are decisions about WHEN a value is still good, which is the caller's domain;
 * folding them in would make this the union of every cache rather than the intersection.
 *
 * Time is passed per call as `nowMs`, not held as a clock — the sanctioned spelling from
 * #614, and the same shape `getAllPreferencesCached(database, { nowMs })` already uses.
 */

export interface TtlMemoOptions {
  /** How long an entry stays fresh. */
  ttlMs: number;
}

export interface TtlMemoReadOptions {
  /** Injectable clock (epoch ms) so a test can cross the TTL boundary without sleeping. */
  nowMs?: number;
}

export interface TtlMemo<K, V> {
  /** The fresh value for `key`, or `undefined` when absent or expired. */
  get(key: K, options?: TtlMemoReadOptions): V | undefined;
  set(key: K, value: V, options?: TtlMemoReadOptions): void;
  /**
   * `fn()`'s result, memoised — and with concurrent callers for the same key sharing ONE
   * in-flight promise rather than each starting their own. That single-flight half is why
   * several of the hand-rolled copies existed at all.
   */
  singleFlight(key: K, fn: () => Promise<V>, options?: TtlMemoReadOptions): Promise<V>;
  /** Drop one key, or — for string keys — every key starting with `prefix`. */
  invalidate(keyOrPrefix?: K | string): void;
  /** Drop everything. What a suite's `afterEach` calls instead of a bespoke reset export. */
  clear(): void;
  /** Live entry count, for diagnostics and tests. */
  readonly size: number;
}

export function createTtlMemo<K, V>({ ttlMs }: TtlMemoOptions): TtlMemo<K, V> {
  const entries = new Map<K, { value: V; at: number }>();
  const inFlight = new Map<K, Promise<V>>();

  const read = (key: K, nowMs: number): V | undefined => {
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (nowMs - hit.at >= ttlMs) {
      // Evict on read rather than leaving it: an expired entry never read again is a leak,
      // and these memos are keyed by workspace/project ids that come and go.
      entries.delete(key);
      return undefined;
    }
    return hit.value;
  };

  return {
    get: (key, options) => read(key, options?.nowMs ?? Date.now()),
    set: (key, value, options) => {
      entries.set(key, { value, at: options?.nowMs ?? Date.now() });
    },
    singleFlight: async (key, fn, options) => {
      const nowMs = options?.nowMs ?? Date.now();
      const fresh = read(key, nowMs);
      if (fresh !== undefined) return fresh;
      const pending = inFlight.get(key);
      if (pending) return pending;
      // Registered BEFORE the first await, or two synchronous callers both miss it and the
      // single-flight guarantee is lost.
      const promise = fn()
        .then((value) => {
          entries.set(key, { value, at: options?.nowMs ?? Date.now() });
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, promise);
      return promise;
    },
    invalidate: (keyOrPrefix) => {
      if (keyOrPrefix === undefined) {
        entries.clear();
        return;
      }
      if (entries.has(keyOrPrefix as K)) {
        entries.delete(keyOrPrefix as K);
        return;
      }
      if (typeof keyOrPrefix === "string") {
        for (const key of [...entries.keys()]) {
          if (typeof key === "string" && key.startsWith(keyOrPrefix)) entries.delete(key);
        }
      }
    },
    clear: () => {
      entries.clear();
      inFlight.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

// Pure bookkeeping for "what's still outstanding" (inbound-pull conflicts, #1078;
// outbound-push failures, #1079), shared by both registers since the shape and the
// rule are identical: track a monotonic ROUND per identity, bump it only when the
// identity re-appears after having been resolved. That round is what gives the loop
// planner a FRESH unit id on a genuine re-occurrence while keeping the SAME id while
// the same underlying problem is still open (rule 1 in docs/plugin-development.md:
// a unit id is a permanent dedupe key; re-reporting it forever does nothing, but a
// resolved-then-recurring problem needs a new id to be re-ticketed at all).
//
// `nowIso` is injectable (see the root CLAUDE.md's two sanctioned time-injection
// spellings) so tests can pin timestamps instead of racing Date.now().

/**
 * @param {{ entries: Record<string, { round: number, resolved: boolean, detectedAt: string, resolvedAt?: string, reason?: string }> }} register
 * @param {Array<{ id: string, reason?: string }>} current - identities the latest run still reports as outstanding
 * @param {{ now?: string }} [opts]
 */
export function updateRegister(register, current, { now = new Date().toISOString() } = {}) {
  const entries = { ...register.entries };
  const currentIds = new Set(current.map((c) => c.id));

  for (const item of current) {
    const prev = entries[item.id];
    if (!prev || prev.resolved) {
      entries[item.id] = {
        round: (prev?.round ?? 0) + 1,
        resolved: false,
        detectedAt: now,
        reason: item.reason,
      };
    } else {
      // Still open from a previous run: keep the round and detectedAt, just refresh the reason.
      entries[item.id] = { ...prev, reason: item.reason ?? prev.reason };
    }
  }

  for (const [id, entry] of Object.entries(entries)) {
    if (!currentIds.has(id) && !entry.resolved) {
      entries[id] = { ...entry, resolved: true, resolvedAt: now };
    }
  }

  return { entries };
}

/** Outstanding (unresolved) entries, as `{ id, round, reason, detectedAt }`. */
export function outstandingEntries(register) {
  return Object.entries(register.entries)
    .filter(([, entry]) => !entry.resolved)
    .map(([id, entry]) => ({ id, round: entry.round, reason: entry.reason, detectedAt: entry.detectedAt }));
}

/** Stable identity for a push-plan `failed` entry — its Jira key when known, else the board issue id. */
export function pushFailureIdentity(failed) {
  return failed.key ?? `board:${failed.boardIssueId}`;
}

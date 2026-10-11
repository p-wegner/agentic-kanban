// What a worker attests about the agent profiles it can authenticate as (#1027): the wire shape and its
// defensive parser. Names only, never a credential. worker-protocol.ts re-exports everything here.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * One profile's quota as the WORKER measured it, against its own tokens (#1027).
 *
 * The numbers are read on the worker by the same throttled OAuth reader the board runs
 * for its own logins (`oauth-quota-core.ts`) — the tokens themselves never move, only the
 * percentages do. Shaped like the board's own reading so `headroomFromAttestations` and
 * `headroomFromQuotaUsage` produce the SAME map, and roster selection cannot behave
 * differently for a local and a remote launch.
 *
 * `stale` is load-bearing and means "old beats wrong": a measurement older than one reset
 * window reads as UNKNOWN, never as exhausted — dropping a profile whose number we simply
 * do not have would take a perfectly usable account out of rotation.
 */
export interface WorkerProfileQuota {
  /** Percent of the 5-hour window USED (0-100), or null when nothing was measured. */
  usedPct5h?: number | null;
  /** Percent of the 7-day window USED (0-100), or null when nothing was measured. */
  usedPct7d?: number | null;
  /** ISO stamp of when the numbers were true. */
  measuredAt?: string | null;
  /** Older than one reset window, or never measured — treat as unknown. */
  stale?: boolean;
}

/**
 * A profile this worker can authenticate as, declared BY NAME (#1027).
 *
 * Names only — never a token, never a config dir, never a settings file. The whole point
 * of decision 012 is that credentials stay on the machine they belong to; an attestation
 * is the worker saying "I can log in as this account", which is a fact the board can act
 * on without ever holding the secret.
 *
 * `role` is the worker's reading of that profile's OWN declaration
 * (`KANBAN_PROFILE_ROLE`, via the shared `profile-attributes.ts` reader) — the same
 * carrier the board reads for its local logins. It is combined with the project's roster
 * by the most-restrictive rule, so a `forbidden` read on EITHER side wins and a worker
 * cannot lift a restriction by declaring a friendlier role.
 */
export interface WorkerProfileAttestation {
  /** Agent provider this profile belongs to ("claude" | "codex"). */
  provider: string;
  /** The profile name, as `--profile`/the roster spells it. */
  name: string;
  /** `pool` | `reserve` | `forbidden`, as the profile declares for itself. Absent = pool. */
  role?: string;
  /** `KANBAN_PROFILE_DEDICATED` — forbidden everywhere except this project slug. */
  dedicatedProject?: string | null;
  /** The worker's own quota reading for this profile. Absent = never measured. */
  quota?: WorkerProfileQuota;
  /**
   * #1331: set when the worker KNOWS it cannot log in as this profile — its OAuth credentials
   * are `expired` or `missing`. Absent = usable (or not an OAuth login, so unknowable). A
   * profile carrying this is listed for visibility but is not runnable: placement skips it.
   */
  credentials?: WorkerProfileCredentialState;
}

export type WorkerProfileCredentialState = "expired" | "missing";

/**
 * Shape-check the attested profile list off the wire (#1027).
 *
 * Anything without a usable `provider`+`name` pair is DROPPED rather than coerced: an
 * attestation is a claim the board grants permission on, so a half-understood entry must
 * not become a permission. Returns undefined for "nothing to say", so an older worker's
 * absent field and a malformed one are the same, safe answer.
 */
export function parseWorkerProfileAttestations(raw: unknown): WorkerProfileAttestation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: WorkerProfileAttestation[] = [];
  const seen = new Set<string>();
  const num = (v: unknown): number | null | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : v === null ? null : undefined;
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!provider || !name) continue;
    const id = `${provider}:${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const quotaRec = asRecord(rec.quota);
    const quota: WorkerProfileQuota | undefined = quotaRec
      ? {
          ...(num(quotaRec.usedPct5h) !== undefined ? { usedPct5h: num(quotaRec.usedPct5h) } : {}),
          ...(num(quotaRec.usedPct7d) !== undefined ? { usedPct7d: num(quotaRec.usedPct7d) } : {}),
          ...(typeof quotaRec.measuredAt === "string" ? { measuredAt: quotaRec.measuredAt } : {}),
          ...(typeof quotaRec.stale === "boolean" ? { stale: quotaRec.stale } : {}),
        }
      : undefined;
    out.push({
      provider,
      name,
      ...(typeof rec.role === "string" && rec.role.trim() ? { role: rec.role.trim() } : {}),
      ...(typeof rec.dedicatedProject === "string" && rec.dedicatedProject.trim()
        ? { dedicatedProject: rec.dedicatedProject.trim() }
        : {}),
      ...(quota ? { quota } : {}),
      ...(rec.credentials === "expired" || rec.credentials === "missing"
        ? { credentials: rec.credentials }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

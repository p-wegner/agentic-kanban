/**
 * A reprobe that could not be PLACED right now is held visibly and retried (#1471).
 *
 * `verify_placement=worker` with no allowlisted worker holding a free verify slot used to make the
 * probe return null silently while the reprobe route had already answered `started:true` — nothing
 * ran, nothing said why, nothing retried. A held reprobe is now recorded here (so
 * `/base-branch-health` can show it) and re-attempted on a timer until placement stops holding,
 * like the workspace gates' retry-at (#1423). In-memory on purpose: a restart reaps the probe-start
 * stamps too, and the operator's next request re-arms it.
 */

export const REPROBE_HOLD_RETRY_MS = 30_000;

export interface HeldReprobe {
  projectId: string;
  branch: string | null;
  /** Why placement refused, e.g. "no allowlisted worker with a free verify slot". */
  reason: string;
  heldSince: string;
  retryAt: string;
  attempts: number;
}

/** Outcome of one retry: `held` = still cannot place (string is the current reason), null = it started. */
export type ReprobeRetry = () => Promise<string | null>;

interface Entry { info: HeldReprobe; retry: ReprobeRetry; timer: ReturnType<typeof setTimeout> | null }

const entries = new Map<string, Entry>();
const keyOf = (projectId: string, branch: string | null) => `${projectId}::${branch ?? ""}`;

export function listHeldReprobes(projectId: string): HeldReprobe[] {
  return [...entries.values()].filter((e) => e.info.projectId === projectId).map((e) => ({ ...e.info }));
}

function arm(key: string, entry: Entry, delayMs: number, nowMs: number): void {
  entry.info.retryAt = new Date(nowMs + delayMs).toISOString();
  entry.timer = setTimeout(() => {
    void (async () => {
      entry.info.attempts += 1;
      const still = await entry.retry().catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      if (entries.get(key) !== entry) return; // superseded or cancelled while the retry ran
      if (still === null) {
        entries.delete(key);
        console.log(`[base-branch-health] held reprobe for project ${entry.info.projectId} placed after ${entry.info.attempts} retr${entry.info.attempts === 1 ? "y" : "ies"}`);
        return;
      }
      entry.info.reason = still;
      arm(key, entry, delayMs, Date.now());
    })();
  }, delayMs);
  entry.timer.unref?.();
}

/** Record a held reprobe and schedule its retry. A second hold for the same lane replaces the first. */
export function holdReprobe(
  args: { projectId: string; branch: string | null; reason: string; retry: ReprobeRetry; retryDelayMs?: number; nowMs?: number },
): HeldReprobe {
  const key = keyOf(args.projectId, args.branch);
  const prior = entries.get(key);
  if (prior?.timer) clearTimeout(prior.timer);
  const nowMs = args.nowMs ?? Date.now();
  const entry: Entry = {
    info: {
      projectId: args.projectId, branch: args.branch, reason: args.reason,
      heldSince: prior?.info.heldSince ?? new Date(nowMs).toISOString(), retryAt: "", attempts: prior?.info.attempts ?? 0,
    },
    retry: args.retry,
    timer: null,
  };
  entries.set(key, entry);
  arm(key, entry, args.retryDelayMs ?? REPROBE_HOLD_RETRY_MS, nowMs);
  console.log(`[base-branch-health] reprobe for project ${args.projectId} held (${args.reason}); retrying every ${(args.retryDelayMs ?? REPROBE_HOLD_RETRY_MS) / 1000}s`);
  return { ...entry.info };
}

/** Drop a pending hold (a probe for that lane was placed by another route). */
export function clearHeldReprobe(projectId: string, branch: string | null): void {
  const key = keyOf(projectId, branch);
  const e = entries.get(key);
  if (e?.timer) clearTimeout(e.timer);
  entries.delete(key);
}

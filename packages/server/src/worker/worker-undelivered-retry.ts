/**
 * Delivering a finished result, and holding on to one that could not be delivered (#899).
 *
 * This is the retention leaf of `worker-agent-runner.ts`: retry a failed push on a bounded
 * backoff, keep what still cannot be pushed (WITH its checkout, so the work stays reachable),
 * persist the token-free FACT of it so a daemon restart does not lose the run, and retry the
 * lot on the next reconnect. #870/#871 grew all of that inside `createWorkerAgentRunner`,
 * taking it from 406 to 469 nloc; the function-nloc baseline disclosed that with this ticket
 * as the promised follow-up.
 *
 * It is a genuine leaf, which is why it extracts cleanly: it holds no runner state at all
 * beyond what is injected here — the board `send`, the git transport, and the work root. The
 * runner keeps the process table, the watchdogs and the capacity accounting; none of it is
 * reachable from this file.
 *
 * **The token is never persisted.** The per-assignment git token a retry needs lives in
 * memory only — writing it under the work root would put a credential on the worker's disk,
 * which is exactly what `worker-repo.ts` goes out of its way to avoid (decision 012). A
 * restored entry therefore carries an EMPTY token, and its failed retry is what routes the
 * session to the board as an `undelivered_result` report rather than as a silent loss.
 */
import { workerLog } from "./worker-updater.js";
import type { WorkerRepoTransport, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { WorkerCheckout } from "./worker-repo.js";
import { existsSync } from "node:fs";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import {
  loadLost,
  loadUndelivered,
  markUndeliveredLost,
  removeUndelivered,
  undeliveredGiveUpReason,
  upsertUndelivered,
  UNDELIVERED_MAX_AUTH_ATTEMPTS,
  type LostSessionRecord,
} from "./worker-undelivered.js";

/** A result that finished on this worker and is on its way to the board. */
export interface PendingResult {
  checkout: WorkerCheckout;
  repo: WorkerRepoTransport;
}

export type PushOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; lastError: string };

/** A finished result the worker is still holding because it could not push it (#750). */
export interface UnpushedResult {
  sessionId: string;
  /** The per-session checkout, kept rather than force-removed, so the work is reachable. */
  checkoutPath: string;
  /** The cache clone that also holds `localBranch`. */
  cacheDir: string;
  /** Local branch carrying the commits: `kanban/<sessionId>`. */
  localBranch: string;
  /** Where the push was aimed: `refs/kanban/incoming/<branch>`. */
  incomingRef: string;
  branch: string;
  attempts: number;
  lastError: string;
}

export interface UndeliveredStoreDeps {
  /** Where the token-free undelivered records live, and where checkouts are kept. */
  workRoot: string;
  boardUrl: string;
  /** Backoff before each RETRY. One entry per retry, so `[a, b]` means up to three attempts. */
  retryDelaysMs: number[];
  push: (boardUrl: string, repo: WorkerRepoTransport, checkout: WorkerCheckout) => Promise<void>;
  cleanup: (checkout: WorkerCheckout) => Promise<void>;
  /**
   * The runner's non-throwing send (#870). Every path here runs on a child's `exit` event or
   * inside a detached promise, so a throw out of the daemon's send callback would be a
   * process-level uncaught exception — the observed "daemon threw … daemon exited" that
   * turned one failed push into every agent on the machine dying.
   */
  safeSend: (message: WorkerToBoardMessage) => void;
  /** Sleep that never keeps the event loop alive on its own. */
  wait: (ms: number) => Promise<void>;
  /**
   * #1383: ask the board for a fresh git token for this session (null = none came). Called
   * once per push, right after a 401, so a rejected token is never simply retried.
   */
  refreshToken?: (sessionId: string) => Promise<string | null>;
  /**
   * Is the work unreachable — checkout directory AND local branch both gone (#1406)? Defaults
   * to a filesystem + `git rev-parse` check.
   */
  isGone?: (entry: UnpushedResult) => Promise<boolean>;
}

/** Default "work is unreachable" probe: no checkout directory and no `kanban/<sid>` branch. */
async function defaultIsGone(entry: UnpushedResult): Promise<boolean> {
  if (existsSync(entry.checkoutPath)) return false;
  if (!existsSync(entry.cacheDir)) return true;
  const probe = await gitExec(["rev-parse", "--verify", "--quiet", `refs/heads/${entry.localBranch}`], {
    cwd: entry.cacheDir,
  });
  return !!probe.error || probe.stdout.trim() === "";
}

/** A git failure that means the board rejected our credential (or git was refused a prompt). */
export const isGitAuthFailure = (message: string): boolean =>
  /(?:^|\D)401(?:\D|$)|Authentication failed|could not read Username|terminal prompts disabled/i.test(message);

/** The board refused the push because the assignment is over (403, #753/#1407) - retrying cannot succeed (#1500). */
export const isAssignmentRefusal = (message: string): boolean =>
  /no longer current|(?:^|\D)403(?:\D|$)/i.test(message);

const localBranchFor =(sessionId: string) => `kanban/${sessionId}`;

/** HEAD sha of a kept result (#1444): the checkout, else the cache clone's `kanban/<sid>` branch. */
export async function resolveResultHeadSha(checkoutPath: string, cacheDir: string, sessionId: string): Promise<string | undefined> {
  const probes: Array<[string, string]> = [
    [checkoutPath, "HEAD"],
    [cacheDir, `refs/heads/${localBranchFor(sessionId)}`],
  ];
  for (const [cwd, rev] of probes) {
    if (!existsSync(cwd)) continue;
    const r = await gitExec(["rev-parse", "--verify", "--quiet", rev], { cwd });
    const sha = r.error ? "" : r.stdout.trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
  }
  return undefined;
}

/** Why a retained result whose push is being refused on credentials should stop retrying, or null (#1444). */
export function authFailureGiveUpReason(attempts: number, prevError: string, error: string): string | null {
  if (attempts < UNDELIVERED_MAX_AUTH_ATTEMPTS || !isGitAuthFailure(error) || !isGitAuthFailure(prevError)) return null;
  return (
    `the push is refused on credentials (${attempts} attempts, limit ${UNDELIVERED_MAX_AUTH_ATTEMPTS}) - the board ` +
    `has most likely revoked this session's git token, so retrying cannot succeed; last error: ${error}`
  );
}

export function createUndeliveredStore(deps: UndeliveredStoreDeps) {
  const { workRoot, safeSend } = deps;
  const unpushed = new Map<
    string,
    { pending: PendingResult; attempts: number; lastError: string; recordedAt: string; onDisk: boolean; headSha?: string }
  >();

  // #871: adopt the previous daemon's undelivered results. In-memory entries cannot exist
  // yet (the map was created one line up), so every persisted record is adopted as-is — the
  // supervisor restarts a dead daemon within seconds, and a fresh process that does not know
  // the entry exists loses the run in every practical sense.
  for (const record of loadUndelivered(workRoot)) {
    unpushed.set(record.sessionId, {
      pending: {
        checkout: { cwd: record.checkoutPath, cacheDir: record.cacheDir },
        repo: {
          projectId: record.projectId,
          gitPort: record.gitPort,
          gitToken: "", // never persisted — see this file's header and worker-undelivered.ts
          branch: record.branch,
          baseBranch: record.baseBranch,
          incomingRef: record.incomingRef,
        },
      },
      attempts: record.attempts,
      lastError: record.lastError || "restored after a daemon restart; not yet retried by this process",
      recordedAt: record.recordedAt || new Date().toISOString(),
      onDisk: true,
      headSha: record.headSha,
    });
    workerLog(
      `[worker] restored an undelivered result from ${workRoot}: sessionId=${record.sessionId} ` +
        `checkout=${record.checkoutPath} target=${record.incomingRef} - retrying on the next connect`,
    );
  }

  /**
   * Set once a drain starts: the current push attempt finishes, but no further backoff is
   * waited out. A 30 s retry sleep inside a 30 s bounded drain would otherwise turn a
   * saveable result into an "abandoned" one for no gain — the result is retained instead.
   */
  let retriesSuspended = false;
  /** Resolved when retries are suspended, so a backoff already in progress is cut short. */
  let wakeSuspended!: () => void;
  const suspendSignal = new Promise<void>((resolve) => {
    wakeSuspended = resolve;
  });

  /** Persist an undelivered entry token-free (#871). Best-effort by contract. */
  function persist(sessionId: string): void {
    const entry = unpushed.get(sessionId);
    if (!entry) return;
    entry.onDisk = upsertUndelivered(workRoot, {
      sessionId,
      branch: entry.pending.repo.branch,
      baseBranch: entry.pending.repo.baseBranch,
      incomingRef: entry.pending.repo.incomingRef,
      checkoutPath: entry.pending.checkout.cwd,
      cacheDir: entry.pending.checkout.cacheDir,
      projectId: entry.pending.repo.projectId,
      gitPort: entry.pending.repo.gitPort,
      attempts: entry.attempts,
      lastError: entry.lastError,
      recordedAt: entry.recordedAt,
      headSha: entry.headSha,
    });
  }

  /** Record the result's HEAD sha once (#1444), then re-persist so the file carries it. */
  async function captureHeadSha(sessionId: string): Promise<void> {
    const entry = unpushed.get(sessionId);
    if (!entry || entry.headSha) return;
    const sha = await resolveResultHeadSha(entry.pending.checkout.cwd, entry.pending.checkout.cacheDir, sessionId).catch(() => undefined);
    if (!sha || !unpushed.has(sessionId)) return;
    entry.headSha = sha;
    persist(sessionId);
  }

  /**
   * Push the result, retrying a FAILED push on the configured backoff (#750).
   *
   * A single-shot push made every transient failure terminal: the board's fleet port
   * bouncing, ten seconds of lost link, or the 401 a board restart produces (#775) all cost a
   * completed agent run. The board must still not see `exit` until this resolves —
   * review/merge would otherwise run against a branch that has not arrived — so the backoff
   * list is deliberately short and a drain can cut it (see `suspendRetries`).
   */
  async function pushWithRetry(sessionId: string, pending: PendingResult): Promise<PushOutcome> {
    let attempts = 0;
    let lastError = "";
    let refreshed = false;
    for (;;) {
      attempts += 1;
      try {
        await deps.push(deps.boardUrl, pending.repo, pending.checkout);
        workerLog(`[worker] pushed session result: sessionId=${sessionId} ref=${pending.repo.incomingRef}`);
        return { ok: true, attempts };
      } catch (err) {
        lastError = errorMessage(err);
        workerLog(`[worker] push failed (attempt ${attempts}): sessionId=${sessionId}: ${lastError}`);
        if (!refreshed && deps.refreshToken && isGitAuthFailure(lastError)) {
          refreshed = true;
          const fresh = await deps.refreshToken(sessionId).catch(() => null);
          if (fresh) {
            pending.repo = { ...pending.repo, gitToken: fresh };
            workerLog(`[worker] got a fresh git token after a 401, retrying now: sessionId=${sessionId}`);
            continue;
          }
          workerLog(`[worker] the board issued no fresh git token: sessionId=${sessionId}`);
        }
      }
      if (isAssignmentRefusal(lastError)) break; // #1500: the board will refuse every retry too
      const delay = deps.retryDelaysMs[attempts - 1];
      if (delay === undefined || retriesSuspended) break;
      safeSend({
        type: "event",
        event: {
          type: "stderr",
          sessionId,
          data:
            `Worker could not push its result (attempt ${attempts} of ${deps.retryDelaysMs.length + 1}): ` +
            `${lastError}. Retrying in ${Math.round(delay / 1000)}s.`,
        },
      });
      // Race the suspend signal: a drain that arrives mid-backoff must not have to wait the
      // sleep out — bounding the drain is the whole point of #754's timeout.
      await Promise.race([deps.wait(delay), suspendSignal]);
      if (retriesSuspended) break;
    }
    return { ok: false, attempts, lastError };
  }

  /**
   * Hold on to a result that could not be pushed, and SAY where it is (#750, #775 item 2).
   *
   * The retained entry is retried on the daemon's next reconnect — the only thing that can
   * save a push whose failure was the board being unreachable, since the in-run backoff is
   * bounded by design.
   */
  function retain(sessionId: string, pending: PendingResult, outcome: PushOutcome & { ok: false }): void {
    unpushed.set(sessionId, {
      pending,
      attempts: outcome.attempts,
      lastError: outcome.lastError,
      recordedAt: new Date().toISOString(),
      onDisk: false,
    });
    // #871: the FACT (not the token) also goes to disk, so the entry survives the daemon
    // restart the supervisor performs 2 s after a crash.
    persist(sessionId);
    void captureHeadSha(sessionId);
    safeSend({
      type: "event",
      event: {
        type: "stderr",
        sessionId,
        data:
          `Worker could not push its result after ${outcome.attempts} attempt(s): ${outcome.lastError}. ` +
          `The work is NOT lost: the checkout is KEPT at ${pending.checkout.cwd} with the commits on ` +
          `local branch ${localBranchFor(sessionId)} (also in the cache clone at ${pending.checkout.cacheDir}), ` +
          `and the worker retries the push to ${pending.repo.incomingRef} on its next reconnect to the board.`,
      },
    });
  }

  /**
   * Retry every retained result once. Called by the daemon when its socket comes back (#750):
   * a push that failed because the board was gone can only be saved by an attempt made after
   * it is back.
   *
   * The session's `exit` has already been delivered (downgraded to non-zero, because the
   * board never saw the work), so a late success does not un-fail it — it lands the commits
   * in the incoming namespace, where the #752 operator surface
   * (`GET/POST /api/workers/incoming`) can land them deliberately.
   */
  async function retryPending(): Promise<{ pushed: string[]; stillPending: string[] }> {
    const pushed: string[] = [];
    // #1416: the file is the operator's surface. An entry we persisted that is no longer in it was
    // deleted on purpose; writing it back from memory is what retried dead results forever.
    const onFile = new Set(loadUndelivered(workRoot).map((r) => r.sessionId));
    for (const [sessionId, entry] of [...unpushed]) {
      if (entry.onDisk && !onFile.has(sessionId)) {
        unpushed.delete(sessionId);
        workerLog(
          `[worker] dropping retained result: sessionId=${sessionId} was removed from ` +
            `${workRoot}/undelivered-results.json by the operator - not retrying or re-writing it`,
        );
        continue;
      }
      const giveUp = undeliveredGiveUpReason(entry);
      if (giveUp) {
        unpushed.delete(sessionId);
        removeUndelivered(workRoot, sessionId);
        workerLog(
          `[worker] giving up on retained result: sessionId=${sessionId}: ${giveUp}; last error: ` +
            `${entry.lastError}. The checkout is kept at ${entry.pending.checkout.cwd}.`,
        );
        continue;
      }
      await captureHeadSha(sessionId); // entries recorded before #1444 have no sha yet
      try {
        await deps.push(deps.boardUrl, entry.pending.repo, entry.pending.checkout);
      } catch (err) {
        entry.attempts += 1;
        const authGiveUp = authFailureGiveUpReason(entry.attempts, entry.lastError, errorMessage(err));
        entry.lastError = errorMessage(err);
        persist(sessionId); // keep the on-disk attempt count/error honest (#871)
        workerLog(`[worker] retained result still cannot be pushed: sessionId=${sessionId}: ${entry.lastError}`);
        if (authGiveUp) {
          markLost(sessionId, authGiveUp);
          continue;
        }
        if (isAssignmentRefusal(entry.lastError)) {
          // #1500: report it to the board (card-visible) BEFORE it leaves the retained list, then stop
          // retrying - a lost result with commits is a data-loss risk, not something to loop on.
          safeSend({
            type: "undelivered_result",
            sessionId,
            branch: entry.pending.repo.branch,
            incomingRef: entry.pending.repo.incomingRef,
            checkoutPath: entry.pending.checkout.cwd,
            attempts: entry.attempts,
            lastError: `${entry.lastError} [board refused: assignment no longer current - NOT retried; sha=${entry.headSha ?? "unknown"}]`,
          });
          markLost(sessionId, `the board refuses the push (assignment no longer current), retrying cannot succeed; last error: ${entry.lastError}`);
          continue;
        }
        await markLostIfGone(sessionId);
        continue;
      }
      unpushed.delete(sessionId);
      removeUndelivered(workRoot, sessionId); // delivered — the persisted entry is cleared (#871)
      pushed.push(sessionId);
      await deps.cleanup(entry.pending.checkout).catch(() => {});
      workerLog(`[worker] retained result pushed on reconnect: sessionId=${sessionId}`);
      safeSend({
        type: "event",
        event: {
          type: "stderr",
          sessionId,
          data:
            `The worker's retained result for this session has now been pushed to ` +
            `${entry.pending.repo.incomingRef}. This session was already closed as failed because the ` +
            `board never saw the work - land the ref from the Worker Fleet incoming view ` +
            `(POST /api/workers/incoming/land) to bring it onto ${entry.pending.repo.branch}.`,
        },
      });
    }
    return { pushed, stillPending: [...unpushed.keys()] };
  }

  /**
   * #1406: an entry whose checkout and branch are gone can never be pushed, so retrying it on
   * every restart is noise that hides real failures. Move it to the `lost` list with one loud
   * line; the board lists it via `listLost`.
   */
  async function markLostIfGone(sessionId: string): Promise<void> {
    const entry = unpushed.get(sessionId);
    if (!entry) return;
    const view = list().find((r) => r.sessionId === sessionId)!;
    let gone = false;
    try {
      gone = await (deps.isGone ?? defaultIsGone)(view);
    } catch {
      return; // cannot tell - keep retrying rather than drop work
    }
    if (!gone) return;
    markLost(
      sessionId,
      `checkout ${view.checkoutPath} and branch ${view.localBranch} no longer exist; last error: ${entry.lastError}`,
    );
  }

  /** Move an entry to the `lost` list and log it with the sha an operator needs (#1444). */
  function markLost(sessionId: string, reason: string): void {
    const entry = unpushed.get(sessionId);
    if (!entry) return;
    if (!markUndeliveredLost(workRoot, sessionId, reason, new Date().toISOString())) return;
    unpushed.delete(sessionId);
    workerLog(
      `[worker] LOST undelivered result, no longer retried: sessionId=${sessionId} branch=${entry.pending.repo.branch} ` +
        `sha=${entry.headSha ?? "unknown"} - ${reason}. Check whether ${entry.headSha ?? entry.pending.repo.branch} is ` +
        `already merged on the board ('agentic-kanban-worker results list' marks landed ones); if not, the work ` +
        `must be redone or restored from the kept checkout/bundle.`,
    );
  }

  /** Results moved to the `lost` list (#1406), for the board and for tests. */
  function listLost(): LostSessionRecord[] {
    return loadLost(workRoot);
  }

  /** Results this worker is still holding, for the daemon's logs and for tests. */
  function list(): UnpushedResult[] {
    return [...unpushed].map(([sessionId, entry]) => ({
      sessionId,
      checkoutPath: entry.pending.checkout.cwd,
      cacheDir: entry.pending.checkout.cacheDir,
      localBranch: localBranchFor(sessionId),
      incomingRef: entry.pending.repo.incomingRef,
      branch: entry.pending.repo.branch,
      attempts: entry.attempts,
      lastError: entry.lastError,
    }));
  }

  /**
   * Stop waiting out retry backoffs (#750). The attempt in flight still finishes, and a
   * result that ends up unpushed is retained (with its checkout) rather than deleted.
   */
  function suspendRetries(): void {
    retriesSuspended = true;
    wakeSuspended();
  }

  return { pushWithRetry, retain, retryPending, list, listLost, suspendRetries };
}

export type UndeliveredStore = ReturnType<typeof createUndeliveredStore>;

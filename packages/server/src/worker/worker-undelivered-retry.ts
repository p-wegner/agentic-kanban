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
import type { WorkerRepoTransport, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { WorkerCheckout } from "./worker-repo.js";
import { loadUndelivered, removeUndelivered, upsertUndelivered } from "./worker-undelivered.js";

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
}

const localBranchFor = (sessionId: string) => `kanban/${sessionId}`;

export function createUndeliveredStore(deps: UndeliveredStoreDeps) {
  const { workRoot, safeSend } = deps;
  const unpushed = new Map<string, { pending: PendingResult; attempts: number; lastError: string }>();

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
    });
    console.warn(
      `[worker] restored an undelivered result from ${workRoot}: sessionId=${record.sessionId} ` +
        `checkout=${record.checkoutPath} target=${record.incomingRef} — retrying on the next connect`,
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
    upsertUndelivered(workRoot, {
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
      recordedAt: new Date().toISOString(),
    });
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
    for (;;) {
      attempts += 1;
      try {
        await deps.push(deps.boardUrl, pending.repo, pending.checkout);
        console.log(`[worker] pushed session result: sessionId=${sessionId} ref=${pending.repo.incomingRef}`);
        return { ok: true, attempts };
      } catch (err) {
        lastError = errorMessage(err);
        console.error(`[worker] push failed (attempt ${attempts}): sessionId=${sessionId}: ${lastError}`);
      }
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
    unpushed.set(sessionId, { pending, attempts: outcome.attempts, lastError: outcome.lastError });
    // #871: the FACT (not the token) also goes to disk, so the entry survives the daemon
    // restart the supervisor performs 2 s after a crash.
    persist(sessionId);
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
    for (const [sessionId, entry] of [...unpushed]) {
      try {
        await deps.push(deps.boardUrl, entry.pending.repo, entry.pending.checkout);
      } catch (err) {
        entry.attempts += 1;
        entry.lastError = errorMessage(err);
        persist(sessionId); // keep the on-disk attempt count/error honest (#871)
        console.warn(`[worker] retained result still cannot be pushed: sessionId=${sessionId}: ${entry.lastError}`);
        continue;
      }
      unpushed.delete(sessionId);
      removeUndelivered(workRoot, sessionId); // delivered — the persisted entry is cleared (#871)
      pushed.push(sessionId);
      await deps.cleanup(entry.pending.checkout).catch(() => {});
      console.log(`[worker] retained result pushed on reconnect: sessionId=${sessionId}`);
      safeSend({
        type: "event",
        event: {
          type: "stderr",
          sessionId,
          data:
            `The worker's retained result for this session has now been pushed to ` +
            `${entry.pending.repo.incomingRef}. This session was already closed as failed because the ` +
            `board never saw the work — land the ref from the Worker Fleet incoming view ` +
            `(POST /api/workers/incoming/land) to bring it onto ${entry.pending.repo.branch}.`,
        },
      });
    }
    return { pushed, stillPending: [...unpushed.keys()] };
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

  return { pushWithRetry, retain, retryPending, list, suspendRetries };
}

export type UndeliveredStore = ReturnType<typeof createUndeliveredStore>;

/**
 * `worker update-check` — the READ-ONLY update path for a standing worker runner (#880,
 * from docs/fleet-version-freshness.md §P3).
 *
 * THE GAP: there is no update mechanism at all for a worker install (§2.2) — the
 * Scheduled-Task supervisor re-execs the same resolved binary forever, and the only
 * version-aware signal is the 409 protocol refusal, which deliberately fires only on a
 * breaking WIRE change. So a worker can sit weeks of compatible bug fixes behind with
 * nothing flagging it. This command closes the middle: it answers "is this install behind
 * the board?" and prints the exact manual steps.
 *
 * SCOPE, deliberately: REPORT, NEVER APPLY. No download, no install, no restart — the
 * process running this check may be executing on the very worker it would update, and a
 * live self-update is its own (deferred) design with its own drain semantics (§P5). The
 * remediation text is the shared `WORKER_UPDATE_REMEDIATION` — the SAME constant the 409
 * protocol-refusal message uses — so the two can never drift on what the fix is.
 *
 * The board's side is `GET /api/workers/:id/update-check` on the worker-facing surface
 * (fleet-port reachable, per-worker bearer token). Db-free like the rest of the worker
 * CLI: this module ships in the standalone worker binary (docs/worker-fleet.md §3).
 */
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_UPDATE_REMEDIATION,
} from "@agentic-kanban/shared/lib/worker-protocol";
import {
  compareWorkerBuild,
  formatBuildFreshness,
  type WorkerBuildFreshness,
} from "@agentic-kanban/shared/lib/worker-build-freshness";
import { resolveOwnPackageVersion } from "../../lib/worker-build.js";
import { readSavedIdentity } from "./worker-doctor.js";

export interface UpdateCheckReport {
  boardUrl: string;
  /** This install's own build — `null` renders as `?`, never as a fabricated version. */
  workerVersion: string | null;
  /** The board's build, from the endpoint. `null` = board did not (or could not) say. */
  boardWorkerVersion: string | null;
  workerProtocolVersion: number;
  boardProtocolVersion: number | null;
  freshness: WorkerBuildFreshness;
  /** Set when the CHECK itself failed (no pairing, unreachable, unauthorized, old board). */
  error: string | null;
  /** The manual steps, present exactly when the verdict calls for them. */
  remediation: string | null;
  /** False when the check could not be completed — never when the worker is merely stale. */
  ok: boolean;
}

function failed(
  boardUrl: string,
  workerVersion: string | null,
  error: string,
): UpdateCheckReport {
  return {
    boardUrl,
    workerVersion,
    boardWorkerVersion: null,
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    boardProtocolVersion: null,
    freshness: "unknown",
    error,
    remediation: null,
    ok: false,
  };
}

export async function runWorkerUpdateCheck(opts: {
  boardUrl: string;
  stateFile: string;
  /** Test seam; defaults to this install's own resolved build. */
  workerVersion?: string;
}): Promise<UpdateCheckReport> {
  const boardUrl = opts.boardUrl.replace(/\/+$/, "");
  const workerVersion = opts.workerVersion ?? resolveOwnPackageVersion() ?? null;
  const identity = readSavedIdentity(opts.stateFile, boardUrl);
  if (!identity) {
    return failed(
      boardUrl,
      workerVersion,
      `no pairing saved for ${boardUrl} — the update-check authenticates with the per-worker token. ` +
        `Pair first: mint a token on the board ('agentic-kanban worker pair') and run ` +
        `'worker start --board ${boardUrl} --token <token>'.`,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${boardUrl}/api/workers/${identity.workerId}/update-check`, {
      headers: { authorization: `Bearer ${identity.workerToken}` },
    });
  } catch (err) {
    return failed(
      boardUrl,
      workerVersion,
      `${boardUrl} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 401) {
    return failed(
      boardUrl,
      workerVersion,
      "the board rejected this machine's bearer token (401) — the worker was revoked, or the board's DB was replaced. Re-pair with a fresh token.",
    );
  }
  if (res.status === 404) {
    // An older board without the endpoint. That is itself an answer about versions, but
    // not one this check can turn into a build diff — say so instead of guessing.
    return failed(
      boardUrl,
      workerVersion,
      "the board answered 404 for /update-check — it predates this command (or --board points at " +
        "a non-fleet URL), so its build cannot be read from here. The board is at least older than " +
        "this worker's own package in that case; upgrading the BOARD is what adds the endpoint.",
    );
  }
  if (!res.ok) {
    return failed(boardUrl, workerVersion, `update-check answered ${res.status}, expected 200`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    boardProtocolVersion?: number;
    boardWorkerVersion?: string | null;
  };
  const boardWorkerVersion = body.boardWorkerVersion ?? null;
  const freshness = compareWorkerBuild(workerVersion ?? undefined, boardWorkerVersion ?? undefined);
  return {
    boardUrl,
    workerVersion,
    boardWorkerVersion,
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    boardProtocolVersion: body.boardProtocolVersion ?? null,
    freshness,
    error: null,
    // The steps apply exactly when this install is provably behind. An ahead-of-board or
    // in-sync worker gets none; unknown says what is missing instead of prescribing.
    remediation: freshness === "behind-board" ? WORKER_UPDATE_REMEDIATION : null,
    ok: true,
  };
}

/** Human-readable report. Plain text — this gets pasted into an issue, like the doctor's. */
export function renderUpdateCheckReport(report: UpdateCheckReport): string {
  const lines: string[] = [];
  lines.push(`Worker update-check against ${report.boardUrl}`);
  lines.push("");
  lines.push(`  this install's build: ${report.workerVersion ?? "?"} (protocol ${report.workerProtocolVersion})`);
  lines.push(
    `  board's worker build:  ${report.boardWorkerVersion ?? "?"} (protocol ${report.boardProtocolVersion ?? "?"})`,
  );
  lines.push("");
  if (report.error) {
    lines.push(`  CHECK FAILED: ${report.error}`);
  } else if (report.freshness === "behind-board") {
    const label = formatBuildFreshness(report.freshness, report.boardWorkerVersion);
    lines.push(`  Verdict: ${label} — a newer worker build exists on the board.`);
    lines.push(`  To update (manual, in this order): ${report.remediation}.`);
  } else if (report.freshness === "ahead-of-board") {
    lines.push(
      "  Verdict: ahead of board — this install is NEWER than the board's checkout. Normal on a " +
        "dev machine testing a fresh tarball; nothing to do here (upgrading the BOARD is a board-side step).",
    );
  } else if (report.freshness === "in-sync") {
    lines.push("  Verdict: in sync — this install matches the board's build.");
  } else {
    lines.push(
      "  Verdict: unknown — one side's build could not be determined ('?' above names which), " +
        "so no direction is claimed.",
    );
  }
  lines.push("");
  lines.push("Report only — nothing was downloaded, installed, or restarted.");
  return lines.join("\n");
}

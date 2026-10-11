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
 * process running this check may be executing on the very worker it would update. The
 * applying half is the DAEMON's self-update (#1338: `worker start --auto-update`, or
 * `worker update <name>` on the board; docs/worker-fleet.md "Updating workers"), and the
 * remediation text points there first. The remediation text is the shared `WORKER_UPDATE_REMEDIATION` — the SAME constant the 409
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
import { parseBuildId, sameBuild } from "../../lib/worker-update.js";
import { readControlFile } from "../../worker/worker-control.js";
import { readPointer, versionsDirFor } from "../../worker/worker-versions.js";
import { readSavedIdentity } from "./worker-doctor.js";
import { probeGlobalVersion } from "./worker-doctor-build-check.js";
import { globalLauncherWarning, harnessUpdateNote } from "./worker-update-notes.js";

/** Which thing `workerVersion` describes (#1360). */
export type UpdateCheckSubjectSource = "daemon" | "current.json" | "own-install";

export interface UpdateCheckReport {
  boardUrl: string;
  /** The judged build (daemon > current.json > this launcher) — `null` renders as `?`, never fabricated. */
  workerVersion: string | null;
  /** Commit id of the judged build, when it carries one. */
  workerBuildId?: string | null;
  /** Where `workerVersion` came from. */
  workerSource?: UpdateCheckSubjectSource;
  /** The board's build, from the endpoint. `null` = board did not (or could not) say. */
  boardWorkerVersion: string | null;
  /** The board's commit id from `/api/workers/build`, when it answered one. */
  boardBuildId?: string | null;
  workerProtocolVersion: number;
  boardProtocolVersion: number | null;
  freshness: WorkerBuildFreshness;
  /** Set when the CHECK itself failed (no pairing, unreachable, unauthorized, old board). */
  error: string | null;
  /** The manual steps, present exactly when the verdict calls for them. */
  remediation: string | null;
  /** False when the check could not be completed — never when the worker is merely stale. */
  ok: boolean;
  /** #1373: stale global launcher, a pairing that predates harness modes. */
  warnings?: string[];
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
  /** Test seam for the board requests; defaults to the global fetch (read at call time). */
  fetchImpl?: typeof fetch;
  /** Test seam for the local daemon control endpoint. */
  controlFetchImpl?: typeof fetch;
  /** Test seam: the globally installed launcher's version (default: probe `npm root -g`). */
  globalVersion?: string | null;
}): Promise<UpdateCheckReport> {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const controlFetch: typeof fetch = opts.controlFetchImpl ?? ((...a) => globalThis.fetch(...a));
  const boardUrl = opts.boardUrl.replace(/\/+$/, "");
  const workerVersion = opts.workerVersion ?? resolveOwnPackageVersion() ?? null;
  const identity = readSavedIdentity(opts.stateFile, boardUrl);
  if (!identity) {
    return failed(
      boardUrl,
      workerVersion,
      `no pairing saved for ${boardUrl} - the update-check authenticates with the per-worker token. ` +
        `Pair first: mint a token on the board ('agentic-kanban worker pair') and run ` +
        `'worker start --board ${boardUrl} --token <token>'.`,
    );
  }

  let res: Response;
  try {
    res = await fetchImpl(`${boardUrl}/api/workers/${identity.workerId}/update-check`, {
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
      "the board rejected this machine's bearer token (401) - the worker was revoked, or the board's DB was replaced. Re-pair with a fresh token.",
    );
  }
  if (res.status === 404) {
    // An older board without the endpoint. That is itself an answer about versions, but
    // not one this check can turn into a build diff — say so instead of guessing.
    return failed(
      boardUrl,
      workerVersion,
      "the board answered 404 for /update-check - it predates this command (or --board points at " +
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
    boardCommit?: string | null;
  };

  // #1360: compare BUILD IDS when both sides carry one — the base semver (`0.1.9`) is identical
  // across every dev build, so it can never say a dev build is outdated.
  const manifest = await fetchBoardManifest(boardUrl, identity.workerToken, fetchImpl);
  const subject = await resolveSubject(opts, workerVersion, controlFetch);
  const boardBuildId = manifest?.buildId?.toLowerCase() || undefined;
  const boardWorkerVersion = manifest?.version ?? body.boardWorkerVersion ?? null;
  let freshness: WorkerBuildFreshness;
  if (subject.buildId && boardBuildId) {
    freshness = sameBuild(subject.buildId, boardBuildId) ? "in-sync" : "behind-board";
  } else {
    freshness = compareWorkerBuild(
      subject.version ?? undefined,
      (body.boardWorkerVersion ?? boardWorkerVersion) ?? undefined,
      body.boardCommit,
    );
  }
  return {
    boardUrl,
    workerVersion: subject.version,
    workerBuildId: subject.buildId ?? null,
    workerSource: subject.source,
    boardWorkerVersion,
    boardBuildId: boardBuildId ?? null,
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    boardProtocolVersion: body.boardProtocolVersion ?? null,
    freshness,
    error: null,
    // The steps apply exactly when this install is provably behind. An ahead-of-board or
    // in-sync worker gets none; unknown says what is missing instead of prescribing.
    remediation: freshness === "behind-board" ? WORKER_UPDATE_REMEDIATION : null,
    ok: true,
    warnings: [
      globalLauncherWarning({
        stateFile: opts.stateFile,
        globalVersion: opts.globalVersion === undefined ? probeGlobalVersion() : opts.globalVersion,
        runningBuild: subject.buildId,
      }),
      harnessUpdateNote(opts.stateFile),
    ].filter((w): w is string => Boolean(w)),
  };
}

/** `GET /api/workers/build` — the board's build manifest. Null on any failure: it only sharpens the verdict. */
async function fetchBoardManifest(
  boardUrl: string,
  workerToken: string,
  fetchImpl: typeof fetch,
): Promise<{ version?: string; buildId?: string } | null> {
  try {
    const res = await fetchImpl(`${boardUrl}/api/workers/build`, {
      headers: { authorization: `Bearer ${workerToken}` },
    });
    if (res.status !== 200) return null;
    const m = (await res.json()) as { version?: unknown; buildId?: unknown };
    return {
      ...(typeof m.version === "string" ? { version: m.version } : {}),
      ...(typeof m.buildId === "string" && m.buildId ? { buildId: m.buildId } : {}),
    };
  } catch {
    return null;
  }
}

interface Subject {
  version: string | null;
  buildId: string | undefined;
  source: UpdateCheckSubjectSource;
}

/**
 * What the check judges: the RUNNING DAEMON (control endpoint), else `versions/current.json`
 * (what the next start runs), else this launcher's own version — never silently the last.
 */
async function resolveSubject(
  opts: { stateFile: string; controlFetchImpl?: typeof fetch },
  ownVersion: string | null,
  controlFetch: typeof fetch,
): Promise<Subject> {
  const ctl = readControlFile(opts.stateFile);
  if (ctl) {
    try {
      const res = await controlFetch(`http://127.0.0.1:${ctl.port}/status`, {
        headers: { "x-worker-control-token": ctl.token },
      });
      if (res.ok) {
        const status = (await res.json()) as { workerVersion?: string };
        if (status.workerVersion) {
          return { version: status.workerVersion, buildId: parseBuildId(status.workerVersion), source: "daemon" };
        }
      }
    } catch {
      /* daemon not answering — fall through to the pointer */
    }
  }
  const pointer = readPointer(versionsDirFor(opts.stateFile));
  if (pointer?.buildId) {
    const hex = /^[0-9a-f]{7,40}$/i.test(pointer.buildId) ? pointer.buildId.toLowerCase() : undefined;
    return { version: pointer.buildId, buildId: hex, source: "current.json" };
  }
  return { version: ownVersion, buildId: parseBuildId(ownVersion), source: "own-install" };
}

/** Human-readable report. Plain text — this gets pasted into an issue, like the doctor's. */
export function renderUpdateCheckReport(report: UpdateCheckReport): string {
  const lines: string[] = [];
  lines.push(`Worker update-check against ${report.boardUrl}`);
  lines.push("");
  const subjectLabel =
    report.workerSource === "daemon"
      ? "running daemon's build"
      : report.workerSource === "current.json"
        ? "installed build (versions/current.json; no daemon answered)"
        : "this install's build";
  const withId = (version: string | null, id: string | null | undefined) =>
    `${version ?? "?"}${id && !version?.includes(id.slice(0, 7)) ? ` [build ${id.slice(0, 9)}]` : ""}`;
  lines.push(
    `  ${subjectLabel}: ${withId(report.workerVersion, report.workerBuildId)} (protocol ${report.workerProtocolVersion})` +
      (report.workerSource === "own-install" ? " - the launcher's own version; no daemon or versions/current.json found" : ""),
  );
  lines.push(
    `  board's worker build:  ${withId(report.boardWorkerVersion, report.boardBuildId)} (protocol ${report.boardProtocolVersion ?? "?"})`,
  );
  lines.push("");
  if (report.error) {
    lines.push(`  CHECK FAILED: ${report.error}`);
  } else if (report.freshness === "behind-board") {
    const label = formatBuildFreshness(report.freshness, report.boardWorkerVersion);
    if (report.workerBuildId && report.boardBuildId) {
      lines.push(
        `  Verdict: outdated - running build ${report.workerBuildId.slice(0, 9)}, board's build is ${report.boardBuildId.slice(0, 9)}.`,
      );
      lines.push("  To update this machine's daemon now: agentic-kanban-worker update-check --apply");
    } else {
      lines.push(`  Verdict: ${label} - a newer worker build exists on the board.`);
      lines.push(`  To update (manual, in this order): ${report.remediation}.`);
    }
  } else if (report.freshness === "ahead-of-board") {
    lines.push(
      "  Verdict: ahead of board - this install is NEWER than the board's checkout. Normal on a " +
        "dev machine testing a fresh tarball; nothing to do here (upgrading the BOARD is a board-side step).",
    );
  } else if (report.freshness === "different-build") {
    lines.push(
      "  Verdict: different build from board - this install was packed from another commit than " +
        "the one the board runs. Not an ordering claim.",
    );
    lines.push("  To switch this machine's daemon to the board's build: agentic-kanban-worker update-check --apply");
  } else if (report.freshness === "in-sync") {
    lines.push("  Verdict: in sync - this install matches the board's build.");
  } else {
    lines.push(
      "  Verdict: unknown - one side's build could not be determined ('?' above names which), " +
        "so no direction is claimed.",
    );
  }
  for (const w of report.warnings ?? []) {
    lines.push("");
    lines.push(`  ${w}`);
  }
  lines.push("");
  lines.push("Report only - nothing was downloaded, installed, or restarted.");
  return lines.join("\n");
}

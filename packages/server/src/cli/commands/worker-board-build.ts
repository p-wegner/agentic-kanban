// #1366 - "does this worker run the build the board serves?" Shared by `worker start` (when
// pairing) and `worker doctor`. Db-free: ships in the standalone worker binary.
import { parseBuildId, sameBuild } from "../../lib/worker-update.js";
import type { DoctorCheck } from "./worker-doctor.js";

export type BoardBuildComparison =
  | { state: "same"; buildId: string }
  | { state: "differs"; own: string; board: string }
  | { state: "unknown"; reason: string };

/**
 * Fetch the board's build id (`GET /api/workers/build`, waiting for a pack in progress) and
 * compare it with `ownVersion`. Never throws; "unknown" when either side carries no build id.
 */
export async function compareWithBoardBuild(opts: {
  boardUrl: string;
  /** A worker token or an unexpired pairing token (the endpoint accepts both, #1358). */
  token: string;
  ownVersion: string | null | undefined;
  fetchImpl?: typeof fetch;
  waitSeconds?: number;
}): Promise<BoardBuildComparison> {
  const own = parseBuildId(opts.ownVersion);
  if (!own) return { state: "unknown", reason: "this worker's version carries no build id" };
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const wait = opts.waitSeconds ?? 30;
  try {
    const res = await fetchImpl(`${opts.boardUrl.replace(/\/+$/, "")}/api/workers/build?wait=${wait}`, {
      headers: { authorization: `Bearer ${opts.token}` },
    });
    if (res.status !== 200) return { state: "unknown", reason: `the board answered ${res.status} for /api/workers/build` };
    const m = (await res.json()) as { buildId?: unknown };
    const board = typeof m.buildId === "string" ? m.buildId.toLowerCase() : "";
    if (!board) return { state: "unknown", reason: "the board's build manifest carries no build id" };
    return sameBuild(own, board) ? { state: "same", buildId: board } : { state: "differs", own, board };
  } catch (err) {
    return { state: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The loud line `worker start` prints (and doctor reuses) when the builds differ. */
export function renderBuildMismatch(own: string, board: string): string {
  return `this worker runs ${own.slice(0, 9)}, the board serves ${board.slice(0, 9)}: run agentic-kanban-worker update-check --apply`;
}

/** `worker doctor`'s check of this worker's build against the board's. WARN on a mismatch, never PASS. */
export async function checkBoardBuild(opts: {
  boardUrl: string;
  token: string | undefined;
  ownVersion: string | null | undefined;
  fetchImpl?: typeof fetch;
  /** A daemon's control file exists: `update-check --apply` has something to talk to (#1374). */
  daemonRunning?: boolean;
  /** The `start` line to print when no daemon runs yet. */
  startCommand?: string;
}): Promise<DoctorCheck> {
  const name = "board build";
  if (!opts.token) return { name, status: "pass", detail: "not paired with this board; build comparison skipped" };
  const cmp = await compareWithBoardBuild({ ...opts, token: opts.token, waitSeconds: 10 });
  if (cmp.state === "same") return { name, status: "pass", detail: `this worker runs the board's build ${cmp.buildId.slice(0, 9)}` };
  if (cmp.state === "differs") {
    return {
      name,
      status: "warn",
      detail: renderBuildMismatch(cmp.own, cmp.board),
      remedy: opts.daemonRunning === false
        ? `No worker daemon runs yet, so update-check --apply has nothing to update. Start it with self-update on: ${opts.startCommand ?? `agentic-kanban-worker start --board ${opts.boardUrl} --auto-update`} (it moves to the board's build before taking work).`
        : "Run `agentic-kanban-worker update-check --apply`, then restart the worker.",
    };
  }
  return { name, status: "pass", detail: `board build not compared (${cmp.reason})` };
}

// Worker build freshness (#879, from docs/fleet-version-freshness.md §P2).
//
// The 409 protocol handshake only fires on an incompatible WIRE change, which is
// deliberately rare — so a worker can be weeks of bug fixes behind and look perfectly
// healthy on the fleet panel forever, because `workerVersion` was display-only. This
// module is the comparison half of making that visible: the board compares each worker's
// reported build against its OWN package version and ships the verdict on the existing
// `GET /api/workers` rows. NON-BLOCKING by design — refusal is `protocolVersion`'s job.
//
// Pure (no Node builtins): consumed by the client panel, the CLI and the server, so it
// must stay safe for the client bundle.

/**
 * How a worker's reported build relates to the board's own.
 *
 * The two directions are DELIBERATELY distinct and must never collapse into a bare
 * "outdated": a worker AHEAD of the board is a normal state (a dev machine testing a
 * newer worker tarball), and labelling it stale would send an operator to "fix" a
 * machine that is fine.
 */
export type WorkerBuildFreshness = "behind-board" | "ahead-of-board" | "in-sync" | "unknown";

interface ParsedBuild {
  major: number;
  minor: number;
  patch: number;
  /** e.g. `dev.abc1234` from a pack-worker `-dev.<sha>` stamp. Undefined = a release. */
  prerelease?: string;
}

function parseBuild(version: string): ParsedBuild | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}

/**
 * Compare a worker's reported build against the board's own.
 *
 * - Either side absent → `unknown`. An absent version stays a `?` at every renderer —
 *   never 0, never "current": "we assumed" and "it said" are different facts
 *   (`WorkerView` in worker-registry.service.ts), and this function must not launder one
 *   into the other.
 * - `-dev.<sha>` prerelease stamps (scripts/pack-worker.mjs) order BELOW their release
 *   per semver, so a worker on `0.1.10-dev.x` against a board on `0.1.10` is behind.
 * - Two DIFFERENT dev stamps on the same base version are not orderable from the strings
 *   alone → `unknown`, not a guess.
 */
export function compareWorkerBuild(
  workerVersion: string | undefined | null,
  boardVersion: string | undefined | null,
): WorkerBuildFreshness {
  if (!workerVersion || !boardVersion) return "unknown";
  if (workerVersion.trim() === boardVersion.trim()) return "in-sync";
  const worker = parseBuild(workerVersion);
  const board = parseBuild(boardVersion);
  if (!worker || !board) return "unknown";
  const triple = (p: ParsedBuild): number[] => [p.major, p.minor, p.patch];
  const [w, b] = [triple(worker), triple(board)];
  for (let i = 0; i < 3; i++) {
    if (w[i]! < b[i]!) return "behind-board";
    if (w[i]! > b[i]!) return "ahead-of-board";
  }
  // Same numeric triple. A prerelease precedes its release (semver §11).
  if (worker.prerelease && !board.prerelease) return "behind-board";
  if (!worker.prerelease && board.prerelease) return "ahead-of-board";
  // Both carry (different) dev stamps — sha suffixes carry no order.
  return "unknown";
}

/**
 * The human wording for a freshness verdict, or null when there is nothing worth
 * printing (in-sync is the quiet default; unknown stays the renderer's existing `?`).
 * One function so the fleet panel and `worker list` cannot drift on the wording.
 */
export function formatBuildFreshness(
  freshness: WorkerBuildFreshness | undefined,
  boardVersion?: string | null,
): string | null {
  const board = boardVersion ? ` (board runs ${boardVersion})` : "";
  if (freshness === "behind-board") return `behind board${board}`;
  if (freshness === "ahead-of-board") return `ahead of board${board}`;
  return null;
}

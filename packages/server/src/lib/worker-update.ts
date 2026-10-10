// Worker self-update vocabulary (#1338) — the pure half, shared by the board routes, the
// registry and the worker daemon. Deliberately db-free and node-free: this module is reachable
// from the standalone worker binary (docs/worker-fleet.md §3).

/**
 * The exit code a SUPERVISED daemon (ak-worker-service.ps1 / ak-worker-run.ps1) quits with
 * after it has installed a new build. The supervisor reads it as "relaunch, no backoff, and
 * re-resolve which build to run" rather than as a crash. 75 = EX_TEMPFAIL: not a failure, try
 * again — and clear of 1 (error), 2 (board refuses this build, #754) and 130 (SIGINT).
 */
export const WORKER_UPDATE_EXIT_CODE = 75;

export const WORKER_UPDATE_STATES = ["current", "updating", "failed"] as const;
export type WorkerUpdateState = (typeof WORKER_UPDATE_STATES)[number];

/** What a worker says about its own update on every heartbeat. */
export interface WorkerUpdateReport {
  state: WorkerUpdateState;
  /** `failed`: why. `updating`: the phase ("waiting for 2 session(s)", "downloading", …). */
  reason?: string;
  /** The board build this update is heading for / failed on. */
  targetBuild?: string;
}

/** `GET /api/workers/build` — what the board's worker build is, and how to verify it. */
export interface WorkerBuildManifest {
  /** The stamped package version inside the tarball, e.g. `0.1.9-dev.ab12cd3`. */
  version: string;
  /** The board's commit sha. A worker compares this (prefix-wise) with the sha in its own version. */
  buildId: string;
  sha256: string;
  size: number;
  boardWorkerVersion: string | null;
  protocolVersion: number;
}

export function parseWorkerUpdateReport(raw: unknown): WorkerUpdateReport | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  if (!(WORKER_UPDATE_STATES as readonly unknown[]).includes(rec.state)) return undefined;
  return {
    state: rec.state as WorkerUpdateState,
    ...(typeof rec.reason === "string" && rec.reason ? { reason: rec.reason.slice(0, 500) } : {}),
    ...(typeof rec.targetBuild === "string" && rec.targetBuild ? { targetBuild: rec.targetBuild.slice(0, 64) } : {}),
  };
}

/**
 * The commit a stamped worker build was packed from: `scripts/pack-worker.mjs` stamps
 * `<version>-dev.<short-sha>`. Undefined for anything else (a registry release, a source
 * checkout) — such a build has no identity to compare, so it must never auto-update.
 */
export function parseBuildId(version: string | undefined | null): string | undefined {
  const match = /-dev\.([0-9a-f]{7,40})$/i.exec(version ?? "");
  return match ? match[1]!.toLowerCase() : undefined;
}

/** Same commit? The worker carries a SHORT sha, the board a full one — compare by prefix. */
export function sameBuild(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/** Drop `--token <v>` / `--token=<v>`: a pairing token is single-use and the pairing is already saved. */
export function stripTokenArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--token") {
      i += 1; // skip its value too
      continue;
    }
    if (arg.startsWith("--token=")) continue;
    out.push(arg);
  }
  return out;
}

/**
 * The command that relaunches the daemon on `entry`: the original argv (state file, work root,
 * labels … all preserved) minus the pairing token.
 */
export function buildRelaunchCommand(
  argv: readonly string[],
  entry: string,
  execPath: string,
): { command: string; args: string[] } {
  return { command: execPath, args: [entry, ...stripTokenArgs(argv)] };
}

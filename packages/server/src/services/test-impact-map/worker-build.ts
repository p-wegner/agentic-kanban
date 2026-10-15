/**
 * Build the test-impact map on a fleet worker (#1440).
 *
 * The worker checks out the main checkout's HEAD from the board's git transport, runs the
 * skill's `impact.mjs build` there, and prints the finished map between two markers; the board
 * pulls the artifact out of the verify log and stores it exactly where a host build would have
 * written it. Placement is the ONE seam (`tryRunOnWorker`): host -> `null` (the caller builds as
 * before), no eligible worker / refused -> `held` with the reason, never a silent host run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import type { Database } from "../../db/index.js";
import { readHeadSha, tryRunOnWorker, VerifyJobHeldError, type VerifyWorkerRunner } from "../verify-job-placement.js";

export const IMPACT_MAP_BEGIN = "<<<IMPACT_MAP_BEGIN>>>";
export const IMPACT_MAP_END = "<<<IMPACT_MAP_END>>>";
/** Printed (exit 0) when the worker checkout has no impact tool: an infra refusal, not a red build (#1506). */
export const IMPACT_TOOL_MISSING = "<<<IMPACT_TOOL_MISSING>>>";
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export interface ImpactMapPlacement {
  projectId: string;
  database: Database;
  /** Injected for tests; defaults to the registered verify runner. */
  workerRunner?: VerifyWorkerRunner | null;
}

export interface PlacedImpactBuild {
  ok: boolean;
  detail: string;
  /** No worker could take it: nothing was built, nothing failed. */
  held?: boolean;
  workerName?: string;
}

const toRepoRelative = (repoPath: string, p: string): string => {
  const rel = relative(repoPath, p).replaceAll("\\", "/");
  return rel.startsWith("..") || isAbsolute(rel) ? p : rel;
};

/** The shell line the worker runs: build, then print the map between the markers. */
export function impactMapWorkerCommand(repoPath: string, tool: string, durations: string | null, mapPath: string): string {
  const build = ["node", JSON.stringify(toRepoRelative(repoPath, tool)), "build"];
  if (durations) build.push("--durations", JSON.stringify(toRepoRelative(repoPath, durations)));
  const mapRel = toRepoRelative(repoPath, mapPath);
  const emit = `process.stdout.write('\\n${IMPACT_MAP_BEGIN}\\n'+require('fs').readFileSync('${mapRel}','utf8')+'\\n${IMPACT_MAP_END}\\n')`;
  // The tool lives in the gitignored `.claude/skills/` (a host-only symlink), so a worker clone may
  // not have it. Exit 0 with a marker rather than letting node die with MODULE_NOT_FOUND (exit 1),
  // which the board reads as a red verdict and re-places every cycle.
  const toolRel = toRepoRelative(repoPath, tool);
  const guard = `if(require('fs').existsSync('${toolRel}'))process.exit(1);console.log('${IMPACT_TOOL_MISSING}')`;
  const guardCmd = `node -e "${guard}"`;
  return `${guardCmd} || (${build.join(" ")} && node -e "${emit}")`;
}

export function extractImpactMapArtifact(log: string): string | null {
  const start = log.lastIndexOf(IMPACT_MAP_BEGIN);
  const end = log.lastIndexOf(IMPACT_MAP_END);
  if (start < 0 || end < start) return null;
  const body = log.slice(start + IMPACT_MAP_BEGIN.length, end).trim();
  try {
    JSON.parse(body);
  } catch {
    return null;
  }
  return body;
}

/** `null` = placement says host. Otherwise the build ran (or was held) on a worker and the map is stored. */
export async function runImpactMapBuildOnWorker(args: {
  placement: ImpactMapPlacement;
  repoPath: string;
  tool: string;
  durations: string | null;
  mapPath: string;
}): Promise<PlacedImpactBuild | null> {
  const { placement, repoPath, mapPath } = args;
  try {
    const placed = await tryRunOnWorker({
      kind: "impact-map", projectId: placement.projectId, database: placement.database, workerRunner: placement.workerRunner,
      command: impactMapWorkerCommand(repoPath, args.tool, args.durations, mapPath), workingDir: repoPath,
      sha: await readHeadSha(repoPath), tier: "impact-map", timeoutMs: BUILD_TIMEOUT_MS,
      runOnHost: async () => ({ exitCode: -1, stdout: "", stderr: "ran on host" }),
    });
    if (!placed) return null;
    const log = placed.result.stdout;
    if (log.includes(IMPACT_TOOL_MISSING)) {
      return { ok: false, held: true, workerName: placed.workerName, detail: `worker ${placed.workerName} has no impact tool checked out (.claude/skills is gitignored); map not refreshed` };
    }
    if (placed.result.exitCode !== 0) return { ok: false, workerName: placed.workerName, detail: `worker ${placed.workerName}: impact build failed: ${log.slice(-400)}` };
    const artifact = extractImpactMapArtifact(log);
    if (!artifact) return { ok: false, workerName: placed.workerName, detail: `worker ${placed.workerName} built but returned no readable map artifact` };
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, artifact, "utf8");
    console.log(`[test-impact-map] map built on worker ${placed.workerName} and stored`);
    return { ok: true, workerName: placed.workerName, detail: `built on worker ${placed.workerName}` };
  } catch (err) {
    if (err instanceof VerifyJobHeldError) return { ok: false, held: true, detail: err.message };
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// `worker results list|drop` (#1444): the operator surface for undelivered-results.json.
// Drops go through the same file lock the daemon writes under, so nobody hand-edits the JSON while
// the daemon may rewrite it. Db-free: this module ships in the standalone worker binary.
import type { Command } from "commander";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { defaultWorkerStateFile } from "../../worker/worker-daemon.js";
import { defaultWorkerWorkRoot } from "../../worker/worker-repo.js";
import {
  dropUndelivered,
  loadLost,
  loadUndelivered,
  type UndeliveredSessionRecord,
} from "../../worker/worker-undelivered.js";
import { cliPathArg } from "../cli-path.js";

/** true/false when the sha is/is not an ancestor of the board's base in the cache clone; null = cannot tell. */
export async function isResultLanded(record: UndeliveredSessionRecord): Promise<boolean | null> {
  if (!record.headSha) return null;
  const base = record.baseBranch || "master";
  for (const target of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    const exists = await gitExec(["rev-parse", "--verify", "--quiet", target], { cwd: record.cacheDir });
    if (exists.error || !exists.stdout.trim()) continue;
    const r = await gitExec(["merge-base", "--is-ancestor", record.headSha, target], { cwd: record.cacheDir });
    if (!r.error) return true;
    // exit 1 = not an ancestor; anything else (unknown object, bad cwd) = cannot tell
    return r.code === 1 ? false : null;
  }
  return null;
}

export function registerWorkerResults(workerCmd: Command): void {
  const results = workerCmd.command("results").description("Undelivered session results this worker still holds (#1444)");
  const rootOption = (cmd: Command): Command =>
    cmd
      .option("--state-file <path>", "Pairing state file (selects the work root)", cliPathArg)
      .option("--work-root <path>", "Worker work root holding undelivered-results.json", cliPathArg);
  const rootOf = (o: { stateFile?: string; workRoot?: string }): string =>
    o.workRoot ?? defaultWorkerWorkRoot(o.stateFile ?? defaultWorkerStateFile());

  rootOption(results.command("list").description("List retained and lost results, with the sha and whether it already landed"))
    .option("--json", "Machine-readable output")
    .action(async (o: { stateFile?: string; workRoot?: string; json?: boolean }) => {
      const workRoot = rootOf(o);
      const rows = [
        ...loadUndelivered(workRoot).map((r) => ({ state: "retained", record: r, reason: r.lastError })),
        ...loadLost(workRoot).map((r) => ({ state: "lost", record: r, reason: r.reason })),
      ];
      const out = [];
      for (const row of rows) {
        const landed = await isResultLanded(row.record);
        out.push({
          state: row.state,
          sessionId: row.record.sessionId,
          branch: row.record.branch,
          sha: row.record.headSha ?? null,
          landed,
          attempts: row.record.attempts,
          recordedAt: row.record.recordedAt,
          reason: row.reason,
        });
      }
      if (o.json) return console.log(JSON.stringify({ workRoot, results: out }, null, 2));
      if (out.length === 0) return console.log(`No undelivered results under ${workRoot}.`);
      for (const r of out) {
        const flag = r.landed === true ? " landed" : r.landed === false ? " not-landed" : "";
        console.log(`${r.state.padEnd(8)} ${r.sessionId} ${r.branch} sha=${r.sha ?? "unknown"}${flag} attempts=${r.attempts}`);
        if (r.reason) console.log(`           ${r.reason}`);
      }
    });

  rootOption(results.command("drop <sessionIds...>").description("Remove results from the retry list (--lost: also the lost list), under the daemon's file lock"))
    .option("--lost", "Also remove entries from the lost list")
    .action((ids: string[], o: { stateFile?: string; workRoot?: string; lost?: boolean }) => {
      const workRoot = rootOf(o);
      const dropped = dropUndelivered(workRoot, ids, { lost: o.lost });
      for (const id of dropped) console.log(`Dropped ${id}.`);
      const missing = ids.filter((id) => !dropped.includes(id));
      for (const id of missing) console.error(`Not found: ${id}${o.lost ? "" : " (lost entries need --lost)"}.`);
      if (missing.length > 0) process.exitCode = 1;
    });
}

import type { Command } from "commander";
import { cliAction, resolveProjectIdArg } from "../shared.js";
import { createLandLocalDeps } from "../../services/train-land-local-deps.js";
import { landTrainLocal } from "../../services/train-land-local.service.js";

function parseNumbers(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  return raw.split(/[,\s]+/).map((t) => Number(t.replace(/^#/, ""))).filter((n) => Number.isInteger(n) && n > 0);
}

/** `train land-local` (#1586): the operator's whole manual train landing as one command. Split from train.ts to keep that file small. */
export function registerTrainLandLocal(trainCmd: Command): void {
  trainCmd
    .command("land-local [train-id]")
    .description("Land a train locally from the main checkout (#1586): pause auto-merge + hold the window, assemble in a sibling .worktrees/ checkout, install, run the gate (check:arch, typecheck, test:mine on the train diff), merge with the standard 'Merge train' subject, close the members, clean up. Auto-merge and the hold are restored on exit, also on failure.")
    .option("--from-window", "Use the open train window's pending members instead of a train row")
    .option("--label <label>", "With --from-window: name the worktree label (e.g. local-202610201757); needed with --continue when several window worktrees exist")
    .option("--continue", "Re-run the gate in the worktree a red run left behind (after committing a fix there)")
    .option("--skip-install", "Skip 'pnpm install -r' in the worktree")
    .option("--on-worker [name]", "Run install + the gate on a verify worker through the board's normal placement (any, or the named one) instead of this host; needs the board server running (#1612)")
    .option("--on-host", "Gate on this host even when a verify worker is connected (default placement is a worker when one is; #1649)")
    .option("--only <issueNumbers>", "Assemble only these issue numbers (comma-separated)")
    .option("--skip <issueNumbers>", "Leave these issue numbers out (comma-separated)")
    .option("--project <projectId>", "Project ID (default: the train's project, else the active project)")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- train land-local <train-id>
  $ pnpm cli -- train land-local --from-window
  $ pnpm cli -- train land-local <train-id> --continue
  $ pnpm cli -- train land-local <train-id> --on-worker          # low-memory host: gate runs on a worker
  $ pnpm cli -- train land-local <train-id> --on-worker verify-1`,
    )
    .action(cliAction(async (trainId: string | undefined, options: { fromWindow?: boolean; label?: string; continue?: boolean; skipInstall?: boolean; onWorker?: boolean | string; onHost?: boolean; only?: string; skip?: string; project?: string }) => {
      const deps = createLandLocalDeps();
      const trainProject = trainId && !options.project ? await deps.getTrainProjectId(trainId) : null;
      const projectId = trainProject ?? await resolveProjectIdArg(options.project);
      const outcome = await landTrainLocal(
        { projectId, trainId, fromWindow: options.fromWindow, label: options.label, continueRun: options.continue, skipInstall: options.skipInstall, onWorker: options.onWorker, onHost: options.onHost, only: parseNumbers(options.only), skip: parseNumbers(options.skip) },
        deps,
      );
      switch (outcome.status) {
        case "landed":
          console.log(`Landed train ${outcome.label} as ${outcome.mergeSha.slice(0, 12)}; closed ${outcome.closed.map((n) => `#${n}`).join(" ")}`);
          process.exit(0);
          break;
        case "red":
          console.error(`RED at ${outcome.step}${outcome.failedSuites.length ? `; failing suites:\n  ${outcome.failedSuites.join("\n  ")}` : ""}\nWorktree left at ${outcome.worktree}. Commit a fix there, then: pnpm cli -- train land-local ${trainId ?? `--from-window --continue --label ${outcome.worktree.split(/[\\/]/).pop()}`}${trainId ? " --continue" : ""}`);
          process.exit(1);
          break;
        case "conflict":
          console.error(`Member ${outcome.branch} conflicts with earlier members. Resolve in ${outcome.worktree} (merge it, commit), then re-run with --continue.`);
          process.exit(1);
          break;
        default:
          console.error(`Error: ${outcome.message}`);
          process.exit(1);
      }
    }));
}

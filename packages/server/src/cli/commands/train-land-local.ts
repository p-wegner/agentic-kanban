import type { Command } from "commander";
import { cliAction, resolveProjectIdArg } from "../shared.js";
import { createLandLocalDeps } from "../../services/train-land-local-deps.js";
import { landTrainLocal } from "../../services/train-land-local.service.js";

/** `train land-local` (#1586): the operator's whole manual train landing as one command. Split from train.ts to keep that file small. */
export function registerTrainLandLocal(trainCmd: Command): void {
  trainCmd
    .command("land-local [train-id]")
    .description("Land a train locally from the main checkout (#1586): pause auto-merge + hold the window, assemble in a sibling .worktrees/ checkout, install, run the gate (check:arch, typecheck, test:mine on the train diff), merge with the standard 'Merge train' subject, close the members, clean up. Auto-merge and the hold are restored on exit, also on failure.")
    .option("--from-window", "Use the open train window's pending members instead of a train row")
    .option("--continue", "Re-run the gate in the worktree a red run left behind (after committing a fix there)")
    .option("--skip-install", "Skip 'pnpm install -r' in the worktree")
    .option("--project <projectId>", "Project ID (default: the train's project, else the active project)")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- train land-local <train-id>
  $ pnpm cli -- train land-local --from-window
  $ pnpm cli -- train land-local <train-id> --continue`,
    )
    .action(cliAction(async (trainId: string | undefined, options: { fromWindow?: boolean; continue?: boolean; skipInstall?: boolean; project?: string }) => {
      const deps = createLandLocalDeps();
      const trainProject = trainId && !options.project ? await deps.getTrainProjectId(trainId) : null;
      const projectId = trainProject ?? await resolveProjectIdArg(options.project);
      const outcome = await landTrainLocal(
        { projectId, trainId, fromWindow: options.fromWindow, continueRun: options.continue, skipInstall: options.skipInstall },
        deps,
      );
      switch (outcome.status) {
        case "landed":
          console.log(`Landed train ${outcome.label} as ${outcome.mergeSha.slice(0, 12)}; closed ${outcome.closed.map((n) => `#${n}`).join(" ")}`);
          process.exit(0);
          break;
        case "red":
          console.error(`RED at ${outcome.step}${outcome.failedSuites.length ? `; failing suites:\n  ${outcome.failedSuites.join("\n  ")}` : ""}\nWorktree left at ${outcome.worktree}. Commit a fix there, then: pnpm cli -- train land-local ${trainId ?? "--from-window"} --continue`);
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

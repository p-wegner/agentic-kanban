// `worker start --toolchain-install/--toolchain-allow` and `worker toolchain list|approve <id>` (#1371).
// Its own file: worker.ts sits at the god-module ceiling. The approve command only writes the owner's
// approval to a file beside the worker's state; the running daemon picks it up and does the install.
import type { Command } from "commander";
import { defaultWorkerStateFile } from "../../worker/worker-daemon.js";
import {
  parseToolchainAllowList,
  parseToolchainInstallPolicy,
  type ToolchainInstallPolicy,
} from "@agentic-kanban/shared/lib/worker-toolchain-install";
import { approveToolchainRequest, readPendingRequests } from "../../worker/worker-toolchain-install.js";
import { cliPathArg } from "../cli-path.js";

export interface ToolchainStartOptions {
  toolchainInstall?: string;
  toolchainAllow?: string;
}

export function addToolchainOptions(cmd: Command): Command {
  return cmd
    .option(
      "--toolchain-install <policy>",
      "Let the board ask this worker to install a project's missing toolchains via mise (#1371): " +
        "never (default) | ask (each request waits for 'worker toolchain approve <id>') | auto (only " +
        "toolchains on --toolchain-allow). Installs go into a worker-owned mise dir, never machine-global.",
    )
    .option("--toolchain-allow <csv>", "With --toolchain-install=auto: the toolchain names that may be installed, e.g. java,go");
}

/** Validate the flags into daemon options; throws on a bad policy so a typo is not silently "never". */
export function toolchainDaemonOptions(o: ToolchainStartOptions): { toolchainInstall?: ToolchainInstallPolicy; toolchainAllow?: string[] } {
  if (o.toolchainInstall === undefined && o.toolchainAllow === undefined) return {};
  const policy = o.toolchainInstall === undefined ? "never" : parseToolchainInstallPolicy(o.toolchainInstall);
  if (!policy) throw new Error(`--toolchain-install must be never, ask or auto (got "${o.toolchainInstall}")`);
  return { toolchainInstall: policy, toolchainAllow: parseToolchainAllowList(o.toolchainAllow) };
}

export function registerWorkerToolchain(workerCmd: Command): void {
  const toolchain = workerCmd.command("toolchain").description("Toolchain install requests from the board (#1371)");
  toolchain
    .command("list")
    .description("Install requests waiting for your approval")
    .option("--state-file <path>", "Pairing state file; the requests live beside it", cliPathArg)
    .action((o: { stateFile?: string }) => {
      const pending = readPendingRequests(o.stateFile ?? defaultWorkerStateFile());
      if (pending.length === 0) console.log("No toolchain install requests pending.");
      for (const p of pending) console.log(`${p.id}  ${p.toolchains.join(", ")}  (asked ${p.requestedAt})`);
    });
  toolchain
    .command("approve <id>")
    .description("Approve a pending install request; the running worker installs it via mise within seconds")
    .option("--state-file <path>", "Pairing state file; the requests live beside it", cliPathArg)
    .action((id: string, o: { stateFile?: string }) => {
      if (!approveToolchainRequest(o.stateFile ?? defaultWorkerStateFile(), id)) {
        console.error(`No pending toolchain request "${id}". Run 'worker toolchain list'.`);
        process.exit(1);
      }
      console.log(`Approved ${id}. The worker installs it now; watch the worker log or the board's worker list.`);
    });
}

/** The `status --watch` suffix for a worker's toolchain install state ("" when it has none). */
export function formatToolchainInstall(t: { state: string; toolchains: string[]; reason?: string } | undefined): string {
  if (!t) return "";
  return ` toolchain-install=${t.state}(${t.toolchains.join(",")})${t.reason ? `: ${t.reason}` : ""}`;
}

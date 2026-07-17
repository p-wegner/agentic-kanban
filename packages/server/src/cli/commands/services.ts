import type { Command } from "commander";
import { planStackSweep, serviceStackWsToken, type StackSweepScope } from "@agentic-kanban/shared";
import { dockerAvailable } from "@agentic-kanban/shared/lib/docker-exec";
import { runMigrations } from "../shared.js";
import { createDefaultComposeRunner } from "../../services/workspace-services.service.js";
import {
  getOrCreateServiceStackInstanceId,
  getNonTerminalWorkspaceIds,
} from "../../repositories/workspace-service-state.repository.js";

/**
 * `services reap` — the deliberate, operator-driven wide sweep for orphaned Docker
 * service stacks (#53). The periodic reaper can only reclaim THIS instance's stacks
 * (names carrying its current instance id); if that id ever changes — a DB reset/
 * restore, an AGENTIC_KANBAN_DIR change, or the documented home-fallback where a
 * worktree dev server drops to ~/.agentic-kanban — the old id's `ak-<oldId>-ws-*`
 * containers + volumes become unreachable by any automatic path. This command finds and
 * (with --yes) reaps them.
 *
 * Deliberately NOT automatic: two boards sharing one daemon is exactly what instance
 * scoping permits, so a naive "down anything not mine" would nuke a co-tenant's LIVE
 * stacks. The sweep is dry-run by default, scoped (current instance / a named id / all),
 * and — the key guard — never reaps a stack whose ws-token matches a LIVE workspace row
 * in this DB (ws-token is the stable identity that survives an id change).
 */
export function registerServicesCommand(program: Command) {
  const servicesCmd = program
    .command("services")
    .description("Per-workspace Docker service-stack maintenance.\n\nSubcommands: reap");

  servicesCmd
    .command("reap")
    .description(
      "Find (and with --yes, tear down) orphaned per-workspace Docker service stacks.\n\n" +
        "Dry-run by default. Scope defaults to THIS board instance's stacks; widen with " +
        "--instance <id> (a specific, e.g. stranded, id) or --all-instances (every managed " +
        "stack — DANGEROUS on a shared daemon, see the warning). A stack is never reaped " +
        "while its workspace is still live in this DB.",
    )
    .option("--yes", "Actually run `docker compose down -v` on the candidates (default: dry-run)")
    .option("--instance <id>", "Only stacks carrying this instance id (e.g. a stranded old id)")
    .option("--all-instances", "Every board-managed stack on the daemon, any instance (co-tenant risk)")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- services reap                      # dry-run, this instance's orphans
  $ pnpm cli -- services reap --yes                # reap this instance's orphans
  $ pnpm cli -- services reap --all-instances      # dry-run: list every managed stack
  $ pnpm cli -- services reap --instance ab12cd34 --yes   # reap a named stranded id
`,
    )
    .action(async (options: { yes?: boolean; instance?: string; allInstances?: boolean; json?: boolean }) => {
      try {
        await runMigrations();

        if (!(await dockerAvailable())) {
          console.error("Docker is not available on this host — nothing to sweep.");
          process.exit(1);
        }

        if (options.instance && options.allInstances) {
          console.error("Choose one of --instance <id> or --all-instances, not both.");
          process.exit(1);
        }

        const runner = createDefaultComposeRunner();
        const [composeProjectNames, currentInstanceId, liveIds] = await Promise.all([
          runner.list(),
          getOrCreateServiceStackInstanceId(),
          getNonTerminalWorkspaceIds(),
        ]);
        const liveWsTokens = new Set(liveIds.map(serviceStackWsToken));

        const scope: StackSweepScope = options.allInstances
          ? { kind: "all" }
          : options.instance
            ? { kind: "instance", id: options.instance }
            : { kind: "current" };

        const plan = planStackSweep({ composeProjectNames, currentInstanceId, liveWsTokens, scope });

        if (options.json) {
          console.log(JSON.stringify({ currentInstanceId, scope, ...plan, applied: false }, null, 2));
        } else {
          console.log(`Service-stack sweep  (this instance: ${currentInstanceId}, scope: ${describeScope(scope)})`);
          console.log(`  live workspaces in this DB: ${liveWsTokens.size}`);
          if (plan.reap.length === 0) {
            console.log("\n  No orphaned stacks to reap under this scope.");
          } else {
            console.log(`\n  Reapable orphans (${plan.reap.length}):`);
            for (const c of plan.reap) {
              const inst = c.instanceId ?? "legacy";
              console.log(`    ${c.name}   [instance ${inst}${inst === currentInstanceId ? " = this" : ""}]`);
            }
          }
        }

        if (options.allInstances && plan.reap.length > 0 && !options.json) {
          console.log(
            "\n  ⚠  --all-instances reaps stacks belonging to OTHER instance ids too. If another\n" +
              "     board shares this Docker daemon, its LIVE stacks live in a different DB whose\n" +
              "     workspaces this command cannot see — they would be torn down. Prefer\n" +
              "     --instance <id> to name a specific stranded id.",
          );
        }

        if (!options.yes) {
          if (plan.reap.length > 0 && !options.json) {
            console.log("\n  Dry-run. Re-run with --yes to tear these down (`docker compose down -v`).");
          }
          process.exit(0);
        }

        // --yes: actually down each candidate. Best-effort per stack; report the tally.
        const reaped: string[] = [];
        const failed: { name: string; stderr: string }[] = [];
        for (const c of plan.reap) {
          const { ok, stderr } = await runner.down({ projectName: c.name, cwd: process.cwd() });
          if (ok) reaped.push(c.name);
          else failed.push({ name: c.name, stderr });
        }

        if (options.json) {
          console.log(JSON.stringify({ currentInstanceId, scope, reaped, failed, applied: true }, null, 2));
        } else {
          console.log(`\n  Reaped ${reaped.length} stack(s).`);
          for (const name of reaped) console.log(`    ✓ ${name}`);
          if (failed.length > 0) {
            console.log(`  ${failed.length} failed:`);
            for (const f of failed) console.log(`    ✗ ${f.name}: ${f.stderr.slice(0, 200)}`);
          }
        }
        process.exit(failed.length > 0 ? 1 : 0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function describeScope(scope: StackSweepScope): string {
  return scope.kind === "all"
    ? "all instances"
    : scope.kind === "instance"
      ? `instance ${scope.id}`
      : "this instance";
}

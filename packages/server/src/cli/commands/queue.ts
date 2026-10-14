import type { Command } from "commander";
import { cliAction, resolveProjectIdArg } from "../shared.js";
import { buildApiUrl } from "./workspace-api-url.js";

const apiBase = () => buildApiUrl("", "/api");

interface FlushPlanBody {
  refusal: string | null;
  dryRunText: string;
  members: Array<{ workspaceId: string; issueNumber: number | null }>;
  healTarget: string;
}

/**
 * `pnpm cli -- queue flush [--dry-run]` (#1463, decision 020): land every ready branch as ONE
 * flush-mode train (gate = check:arch + typecheck, no bisect), then heal the red afterwards.
 * Same door as the delivery view's Flush button — `POST /api/projects/:id/queue/flush`, so the
 * rails (`queue_flush_<id>`, posture rung, daily cap, promotion in flight) are the server's.
 *
 * Exit code: 0 = started (or dry-run says it would run), 1 = refused or failed. A real flush is
 * detached on the server; follow it with `pnpm cli -- tracker` or `train list`.
 */
export function registerQueueCommand(program: Command) {
  const queueCmd = program
    .command("queue")
    .description("The merge queue's pressure valve.\n\nSubcommands: flush");

  queueCmd
    .command("flush")
    .description("Flush the queue: land every ready branch as one train with a reduced gate, then heal afterwards.")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--dry-run", "Show what would flush (or why it would be refused) and exit")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText("after", `
Needs queue_flush_<projectId> = manual | auto. The 'standard' and 'strict' risk postures refuse a
flush by design: lower the rung to flow/iterate for the flush, and raise it again afterwards.

Examples:
  $ pnpm cli -- queue flush --dry-run
  $ pnpm cli -- queue flush`)
    .action(cliAction(async (options: { project?: string; dryRun?: boolean; json?: boolean }) => {
      const projectId = await resolveProjectIdArg(options.project);
      const res = await fetch(`${apiBase()}/projects/${encodeURIComponent(projectId)}/queue/flush`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: options.dryRun === true, triggeredBy: "cli" }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; refused?: string; started?: boolean; plan?: FlushPlanBody; error?: string };
      if (options.json) {
        console.log(JSON.stringify(body, null, 2));
        if (!res.ok) process.exit(1);
        return;
      }
      if (!res.ok && !body.refused) {
        console.error(`Error ${res.status}: ${body.error ?? "flush request failed"}`);
        process.exit(1);
      }
      if (body.refused) {
        console.error(`flush refused: ${body.refused}`);
        process.exit(1);
      }
      if (options.dryRun) {
        console.log(body.plan?.dryRunText ?? "flush would run");
        return;
      }
      console.log(`flush started: ${body.plan?.members.length ?? 0} branch(es), heal target: ${body.plan?.healTarget ?? "?"}. Follow it with 'pnpm cli -- tracker'.`);
    }));
}

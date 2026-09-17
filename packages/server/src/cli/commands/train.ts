import type { Command } from "commander";
import { cliAction, resolveProjectIdArg } from "../shared.js";
import { buildApiUrl } from "./workspace-api-url.js";
import type { MergeTrainRowDto } from "@agentic-kanban/shared";

const apiBase = () => buildApiUrl("", "/api");

/** `GET /api/merge-queue/trains/:id` — the row with its two JSON columns parsed and the attempts lifted. */
interface MergeTrainDetail extends Omit<MergeTrainRowDto, "gateEvidence" | "bisectResult"> {
  gateEvidence: unknown;
  bisectResult: unknown;
  attempts: unknown[];
}

function parseMemberCount(memberWorkspaceIds: string): number {
  try {
    const parsed: unknown = JSON.parse(memberWorkspaceIds);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function formatTrainLine(t: MergeTrainRowDto): string {
  const window = t.finishedAt
    ? `${t.startedAt.slice(0, 19)}..${t.finishedAt.slice(0, 19)}`
    : `${t.startedAt.slice(0, 19)}..now`;
  return `${t.id}  [${t.state}]  ${parseMemberCount(t.memberWorkspaceIds)} member(s)  ${window}`;
}

export function registerTrainCommand(program: Command) {
  const trainCmd = program
    .command("train")
    .description("Inspect and manage merge trains (batched, gated release trains).\n\nSubcommands: list, show, cancel, depart");

  // ── list ─────────────────────────────────────────────────────────────────
  trainCmd
    .command("list")
    .description("List merge trains for a project (newest first).")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--state <state>", "Filter by train state: assembling | gating | landing | landed | red | abandoned")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- train list
  $ pnpm cli -- train list --state gating
  $ pnpm cli -- train list --json`,
    )
    .action(cliAction(async (options: { project?: string; state?: string; json?: boolean }) => {
      const projectId = await resolveProjectIdArg(options.project);
      const res = await fetch(`${apiBase()}/merge-queue/trains?projectId=${encodeURIComponent(projectId)}`);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; trains?: MergeTrainRowDto[]; error?: string };
      if (!res.ok || !body.ok) {
        console.error(`Error ${res.status}: ${body.error ?? "failed to list merge trains"}`);
        process.exit(1);
      }
      let trains = body.trains ?? [];
      if (options.state) trains = trains.filter((t) => t.state === options.state);
      if (options.json) {
        console.log(JSON.stringify(trains, null, 2));
      } else if (trains.length === 0) {
        console.log("No merge trains found.");
      } else {
        for (const t of trains) console.log(formatTrainLine(t));
      }
      process.exit(0);
    }));

  // ── show ─────────────────────────────────────────────────────────────────
  trainCmd
    .command("show <train-id>")
    .description("Show a single merge train: state, members, gate evidence, and its bisect-tree attempts.")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- train show <train-id>
  $ pnpm cli -- train show <train-id> --json`,
    )
    .action(cliAction(async (trainId: string, options: { json?: boolean }) => {
      const res = await fetch(`${apiBase()}/merge-queue/trains/${encodeURIComponent(trainId)}`);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; train?: MergeTrainDetail; error?: string };
      if (!res.ok || !body.ok || !body.train) {
        console.error(`Error ${res.status}: ${body.error ?? "train not found"}`);
        process.exit(1);
      }
      const t = body.train as MergeTrainDetail;
      if (options.json) {
        console.log(JSON.stringify(t, null, 2));
        process.exit(0);
      }
      console.log(`ID:       ${t.id}`);
      console.log(`Project:  ${t.projectId}`);
      console.log(`State:    ${t.state}`);
      console.log(`Members:  ${parseMemberCount(t.memberWorkspaceIds)}`);
      console.log(`Started:  ${t.startedAt}`);
      if (t.finishedAt) console.log(`Finished: ${t.finishedAt}`);
      if (t.reconciledReason) console.log(`Reason:   ${t.reconciledReason}`);
      const evidence = t.gateEvidence as
        | { gateRuns?: number; landed?: string[]; dropped?: unknown[]; unresolved?: unknown[]; mergeSha?: string | null }
        | null;
      if (evidence) {
        console.log(`Gate runs: ${evidence.gateRuns ?? 0}`);
        if (evidence.landed) console.log(`Landed:    ${evidence.landed.length}`);
        if (evidence.dropped) console.log(`Dropped:   ${evidence.dropped.length}`);
        if (evidence.unresolved) console.log(`Unresolved: ${evidence.unresolved.length}`);
        if (evidence.mergeSha) console.log(`Merge SHA: ${evidence.mergeSha}`);
      }
      console.log(`Attempts: ${t.attempts.length}`);
      process.exit(0);
    }));

  // ── cancel ───────────────────────────────────────────────────────────────
  trainCmd
    .command("cancel <train-id>")
    .description("Cancel a merge train (#1153). Fails when the train is already terminal (landed/red/abandoned).")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- train cancel <train-id>
  $ pnpm cli -- train cancel <train-id> --json`,
    )
    .action(cliAction(async (trainId: string, options: { json?: boolean }) => {
      const res = await fetch(`${apiBase()}/merge-queue/trains/${encodeURIComponent(trainId)}/cancel`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        console.error(`Error ${res.status}: ${body.error ?? "cancel failed"}`);
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(body, null, 2));
      } else {
        console.log(`Train ${trainId} cancelled.`);
      }
      process.exit(0);
    }));

  // ── depart ───────────────────────────────────────────────────────────────
  trainCmd
    .command("depart <project>")
    .description("Operator 'depart now' (#1186): release a project's merge-train batching window immediately, regardless of size, wait, or a busy gate.")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- train depart my-project
  $ pnpm cli -- train depart my-project --json`,
    )
    .action(cliAction(async (projectArg: string, options: { json?: boolean }) => {
      const projectId = await resolveProjectIdArg(projectArg);
      const res = await fetch(`${apiBase()}/merge-queue/window/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; window?: unknown; error?: string };
      if (!res.ok || !body.ok) {
        console.error(`Error ${res.status}: ${body.error ?? "release failed"}`);
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(body, null, 2));
      } else {
        console.log(`Merge-train window released for project ${projectId}.`);
      }
      process.exit(0);
    }));
}

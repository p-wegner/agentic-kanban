import type { Command } from "commander";
import { parseSessionSummary, computeFrictionStats, extractKeywords } from "@agentic-kanban/shared";
import type { SessionFrictionStats } from "@agentic-kanban/shared";
import { getCommitsForBranch } from "@agentic-kanban/shared/lib/git-service";
import { runMigrations, getActiveProjectId } from "../shared.js";
import {
  getSessionMessageRows,
  getSessionById,
  getRecentSessionsWithContext,
  getSessionsForFrictionBackfill,
  updateSessionStats,
  getReviewerFixSessionRows,
  getSessionTranscriptContext,
  getNewestSessionMessages,
  searchTranscriptMessages,
  getLatestSessionIdForWorkspace,
  getInsightsSessionRows,
} from "../../repositories/session.repository.js";
import { getWorkspaceById } from "../../repositories/workspace.repository.js";
import { getProjectById } from "../../repositories/project.repository.js";
import { getIssueWithStatusById, getIssueTitleDescriptionByNumber } from "../../repositories/issue.repository.js";
import { getAllFailurePatterns } from "../../repositories/failure-pattern.repository.js";
import { computeReviewEffectiveness, renderReviewEffectivenessReport } from "../../services/review-effectiveness.service.js";
import { buildReviewWorkspaces, buildReviewResult, summarizeReviewEffectiveness, reviewPct, computeDeepReviewSignals, type ReviewResult, type ReviewTranscriptSummary } from "../../lib/review-effectiveness-report.js";

const DEFAULT_PORT = process.env.KANBAN_SERVER_PORT ?? "3001";
const BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

/**
 * Shape of the persisted, JSON-parsed `session.stats` blob this command reads.
 * Every field is optional because the blob is untyped persisted JSON and each
 * access falls back to a default — narrowing here keeps the parse boundary typed
 * without asserting fields that may be absent.
 */
interface ParsedSessionStats {
  durationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  model?: string;
  success?: boolean;
  agentSummary?: string;
}

export function registerSessionCommand(program: Command) {
  const sessionCmd = program.command("session").description("Inspect agent sessions.\n\nSubcommands: analyze, recent, backfill-friction, review-effectiveness, transcript, search, stats, friction, find-similar");

  sessionCmd
    .command("analyze <session-id>")
    .description("Show a consolidated analysis of a session: workspace, issue, parsed summary with tool patterns, stats, and errors.")
    .action(async (sessionId: string) => {
      try {
        await runMigrations();

        const session = await getSessionById(sessionId);
        if (!session) {
          console.error(`Session '${sessionId}' not found.`);
          process.exit(1);
        }

        const ws = await getWorkspaceById(session.workspaceId);

        let issue: Record<string, unknown> | null = null;
        if (ws) {
          issue = await getIssueWithStatusById(ws.issueId);
        }

        const msgRows = await getSessionMessageRows(sessionId);

        const summary = parseSessionSummary(msgRows);

        let stats: ParsedSessionStats | null = null;
        if (session.stats) {
          try { stats = JSON.parse(session.stats) as ParsedSessionStats; } catch { /* ignore */ }
        }

        console.log(JSON.stringify({
          session: {
            id: session.id,
            status: session.status,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            executor: session.executor,
            triggerType: session.triggerType,
          },
          workspace: ws ? {
            id: ws.id,
            branch: ws.branch,
            status: ws.status,
            workingDir: ws.workingDir,
            isDirect: ws.isDirect,
          } : null,
          issue,
          summary,
          stats: stats ? {
            durationMs: stats.durationMs ?? 0,
            totalCostUsd: stats.totalCostUsd ?? 0,
            inputTokens: stats.inputTokens ?? 0,
            outputTokens: stats.outputTokens ?? 0,
            numTurns: stats.numTurns ?? 1,
            model: stats.model ?? summary.model,
            success: stats.success ?? false,
            agentSummary: stats.agentSummary,
          } : null,
        }, null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  sessionCmd
    .command("recent")
    .description("List the most recent sessions across all workspaces with metadata.")
    .option("-n, --limit <count>", "Number of sessions to show", "5")
    .action(async (options: { limit?: string }) => {
      try {
        await runMigrations();

        const limit = Math.min(parseInt(options.limit ?? "5", 10), 20);

        const rows = await getRecentSessionsWithContext(limit);

        console.log(JSON.stringify(rows.map(r => ({
          sessionId: r.sessionId,
          sessionStatus: r.sessionStatus,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          executor: r.executor,
          triggerType: r.triggerType,
          workspace: { id: r.workspaceId, branch: r.branch, status: r.wsStatus },
          issue: { number: r.issueNumber, title: r.issueTitle },
        })), null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  sessionCmd
    .command("backfill-friction")
    .description("Populate friction stats (tool failures, repeated commands, errors) for past sessions from their stored messages, so /api/insights friction covers history. Idempotent — skips sessions that already have friction.")
    .option("--hours <n>", "Only backfill sessions started within the last N hours", "48")
    .option("--all", "Backfill all sessions regardless of age (overrides --hours)")
    .option("--force", "Recompute friction even for sessions that already have it")
    .action(async (options: { hours?: string; all?: boolean; force?: boolean }) => {
      try {
        await runMigrations();

        const sinceIso = new Date(
          Date.now() - Math.max(1, parseInt(options.hours ?? "48", 10) || 48) * 60 * 60 * 1000,
        ).toISOString();

        const candidates = await getSessionsForFrictionBackfill({
          includeAll: !!options.all,
          sinceIso,
        });

        let scanned = 0, updated = 0, skipped = 0, empty = 0;
        for (const s of candidates) {
          scanned++;
          let stats: Record<string, unknown> = {};
          if (s.stats) {
            try { stats = JSON.parse(s.stats) as Record<string, unknown>; } catch { stats = {}; }
          }
          if (stats.friction && !options.force) { skipped++; continue; }

          const msgRows = await getSessionMessageRows(s.id);

          const summary = parseSessionSummary(msgRows);
          const friction = computeFrictionStats(summary);
          if (friction.totalToolCalls === 0 && friction.errorCount === 0 && friction.repeatedCommands.length === 0) {
            empty++;
            continue;
          }
          stats.friction = friction;
          await updateSessionStats(s.id, JSON.stringify(stats));
          updated++;
        }

        console.log(JSON.stringify({ scanned, updated, skipped, empty }, null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  sessionCmd
    .command("review-effectiveness")
    .description(
      "Measure how the ticket-implementation workflow interacts with AI code review over a window.\n" +
        "Reconstructs each ticket's build->review->merge lifecycle from sessions + workspaces + diff comments.\n" +
        "Code-review agent runs are identified by triggerType 'review' or 'skill:code-review*'.",
    )
    .option("--days <n>", "Window size in days", "14")
    .option("--project <id>", "Project id (defaults to the active project)")
    .option("--json", "Emit machine-readable JSON instead of a formatted report")
    .option(
      "--deep",
      "Also load each review session's transcript and classify its self-reported verdict (approve vs changes-requested). Slower.",
    )
    .action(async (options: { days?: string; project?: string; json?: boolean; deep?: boolean }) => {
      try {
        await runMigrations();

        const days = Math.max(1, parseInt(options.days ?? "14", 10) || 14);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const projectId = options.project ?? (await getActiveProjectId());

        const report = await computeReviewEffectiveness({ projectId, sinceIso, deep: options.deep });

        if (options.json) {
          console.log(JSON.stringify({ ...report, window: { days, since: sinceIso, projectId } }, null, 2));
          process.exit(0);
        }

        console.log(
          renderReviewEffectivenessReport(
            report,
            `=== AI Code-Review Effectiveness — last ${days}d (project ${projectId.slice(0, 8)}) ===`,
          ),
        );
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  sessionCmd
    .command("reviewer-fixes")
    .description(
      "Measure how often the code-review agent FIXES findings itself (and commits) vs only approving.\n" +
        "Two independent methods, cross-checked:\n" +
        "  • git  — attributes each branch commit (author date) to the session that was running when it was authored;\n" +
        "           a commit landing inside a review session's window == the reviewer committed a fix.\n" +
        "  • deep — parses each review transcript for code edits + git commits + CRITICAL/MAJOR severity (heuristic).\n" +
        "Use --deep to get the MAJOR/CRITICAL breakdown (slower; loads every review transcript).",
    )
    .option("--days <n>", "Window size in days", "14")
    .option("--project <id>", "Project id (defaults to the active project)")
    .option("--limit <n>", "Cap the number of reviewed workspaces inspected (0 = all)", "0")
    .option("--json", "Emit machine-readable JSON instead of a formatted report")
    .option("--deep", "Also parse review transcripts for edits/commits/severity (CRITICAL/MAJOR). Slower.")
    .action(async (options: { days?: string; project?: string; limit?: string; json?: boolean; deep?: boolean }) => {
      try {
        await runMigrations();

        const days = Math.max(1, parseInt(options.days ?? "14", 10) || 14);
        const limit = Math.max(0, parseInt(options.limit ?? "0", 10) || 0);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const projectId = options.project ?? (await getActiveProjectId());

        const project = await getProjectById(projectId);
        const repoPath = project?.repoPath;
        if (!repoPath) {
          console.error(`Project '${projectId}' has no repoPath.`);
          process.exit(1);
        }

        const rows = await getReviewerFixSessionRows({ projectId, sinceIso });

        const GRACE_MS = 2 * 60 * 1000; // a commit can land just after the session's recorded endedAt
        // Classification, epoch-ms session windows (closed so they don't overlap), and
        // strict timezone-safe commit attribution all live in the pure, tested
        // review-effectiveness-report lib — see its tests for the edge cases.
        const byWs = buildReviewWorkspaces(rows, Date.now());

        // Every reviewed workspace is a candidate. The transcript method works on all of them;
        // the git method additionally needs a baseCommitSha + a reachable head.
        let targets = [...byWs.values()].filter((w) => w.hasReview);
        targets.sort((a, b) => a.issueNumber - b.issueNumber);
        const gitEligible = targets.filter((w) => w.baseCommitSha && w.headRef).length;
        if (limit > 0) targets = targets.slice(0, limit);

        const results: ReviewResult[] = [];
        for (const ws of targets) {
          const commits = ws.baseCommitSha && ws.headRef ? await getCommitsForBranch(repoPath, ws.baseCommitSha, ws.headRef) : [];
          results.push(buildReviewResult(ws, commits, GRACE_MS));
        }

        // Deep transcript pass: per review session, did it change code / commit / cite MAJOR-CRITICAL.
        if (options.deep) {
          for (const res of results) {
            const summaries: ReviewTranscriptSummary[] = [];
            for (const sid of res.reviewSessionIds) {
              summaries.push(parseSessionSummary(await getSessionMessageRows(sid)) as unknown as ReviewTranscriptSummary);
            }
            Object.assign(res, computeDeepReviewSignals(summaries, res.reviewerCommits));
          }
        }

        const reviewedInWindow = [...byWs.values()].filter((w) => w.hasReview).length;
        const {
          report,
          gitResolvedCount,
          reviewerCommittedCount,
          highConfReviewerCount,
          totalReviewerCommits,
          totalImplCommits,
          totalReworkCommits,
        } = summarizeReviewEffectiveness(results, {
          reviewedWorkspacesInWindow: reviewedInWindow,
          gitEligible,
          deep: !!options.deep,
          window: { days, since: sinceIso, projectId, repoPath },
        });

        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          process.exit(0);
        }

        const g = report.gitMethod as Record<string, number>;
        const L: string[] = [];
        L.push(`\n=== Reviewer-fixes analysis — last ${days}d (project ${projectId.slice(0, 8)}) ===`);
        L.push(`Reviewed workspaces in window: ${reviewedInWindow}  |  inspected: ${results.length}  |  git-eligible: ${gitEligible}  |  git history resolved: ${gitResolvedCount}`);
        if (options.deep) {
          const d = report.deepMethod as Record<string, unknown>;
          const m = report.methodAgreement as Record<string, number>;
          L.push(`\n-- TRANSCRIPT method [PRIMARY] (what each review session actually did) --`);
          L.push(`  Reviews that edited code themselves:      ${d.reviewsThatEditedCode}/${results.length}  (${reviewPct(d.reviewsThatEditedCode as number, results.length)}%)`);
          L.push(`  Reviews citing a MAJOR/CRITICAL finding:  ${d.reviewsCitingMajorOrCritical}/${results.length}`);
          L.push(`  Reviews that FIXED a MAJOR/CRITICAL:      ${d.reviewsThatFixedAMajorOrCriticalFinding}/${results.length}  (${d.pctOfReviewedThatFixedMajorCritical}%)`);
          L.push(`  └ severity is a heuristic text scan; treat as approximate`);
          L.push(`  Fixed major/critical on issues: ${(d.fixedMajorCriticalIssues as number[]).map((i) => "#" + i).join(", ") || "(none)"}`);
          L.push(`\n-- Method agreement (transcript vs git) --`);
          L.push(`  both say reviewer fixed: ${m.bothAgreeReviewerFixed}  |  transcript-only: ${m.sessionTranscriptOnly}  |  git-only: ${m.gitOnly}`);
        } else {
          L.push(`\n(!) Run with --deep for the reliable transcript-based "reviewer fixed a MAJOR/CRITICAL" numbers.`);
        }
        L.push(`\n-- GIT method [corroboration, APPROX] (commit author-time inside a review window) --`);
        L.push(`  ⚠ under-counts: base..mergedHeadSha is rebase-polluted & mergedHeadSha often null; strict windowing drops ambiguous commits`);
        L.push(`  Reviewer committed within a review window in:  ${reviewerCommittedCount}/${gitResolvedCount} git-resolved workspaces  (${g.pctOfGitResolvedWhereReviewerCommitted}%)`);
        L.push(`  └ HIGH-CONFIDENCE (commit names its own issue, noise-filtered): ${highConfReviewerCount}/${gitResolvedCount}  (${g.pctOfGitResolvedHighConfidence}%)`);
        L.push(`  Window-attributed commits by role:  implementer=${totalImplCommits}  reviewer=${totalReviewerCommits}  rework=${totalReworkCommits}`);
        L.push(`  Reviewer-fixed workspaces that merged: ${g.reviewerFixesThatMerged}/${reviewerCommittedCount}`);
        L.push(`\n-- Workspaces where a commit landed in a review window (git; ✓ = commit names its own issue) --`);
        const fixed = results.filter((r) => r.reviewerCommits > 0).sort((a, b) => b.reviewerCommitsNamingIssue - a.reviewerCommitsNamingIssue || b.reviewerCommits - a.reviewerCommits);
        if (!fixed.length) L.push("  (none)");
        for (const r of fixed) {
          L.push(`  ${r.reviewerCommitsNamingIssue > 0 ? "✓" : " "} #${r.issue} [${r.provider ?? "?"}] reviewer+${r.reviewerCommits} impl+${r.implementerCommits}${options.deep && r.reviewFixedMajorCritical ? "  ⚑MAJOR/CRIT" : ""}  ${r.title}`);
          for (const subj of r.reviewerCommitSubjects) L.push(`        └ ${subj}`);
        }
        L.push("");
        console.log(L.join("\n"));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
  // ── transcript ──────────────────────────────────────────────────────────────
  sessionCmd
    .command("transcript <session-id>")
    .description("Retrieve a session transcript: metadata, workspace, issue, and ordered messages.")
    .option("--limit <n>", "Maximum messages to return (newest selected, returned in chrono order)", "200")
    .option("--json", "Emit raw JSON (default)")
    .addHelpText("after", `
Examples:
  pnpm cli -- session transcript abc123
  pnpm cli -- session transcript abc123 --limit 50`)
    .action(async (sessionId: string, options: { limit?: string; json?: boolean }) => {
      try {
        const limit = Math.min(parseInt(options.limit ?? "200", 10) || 200, 1000);
        const res = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/output`);
        if (!res.ok) {
          console.error(`Server returned ${res.status}: ${await res.text()}`);
          process.exit(1);
        }
        // /output returns the session messages; also fetch summary for metadata
        const outputData = await res.json();

        // Fetch session metadata from DB for project/issue/workspace context
        await runMigrations();
        const meta = await getSessionTranscriptContext(sessionId);

        if (!meta) {
          console.error(`Session '${sessionId}' not found.`);
          process.exit(1);
        }

        // Fetch messages from DB (capped to limit), oldest-first for display.
        const newestMessages = await getNewestSessionMessages(sessionId, limit);
        const msgs = newestMessages.reverse();

        console.log(JSON.stringify({ ...meta, messages: msgs, _serverOutput: outputData }, null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── search ───────────────────────────────────────────────────────────────────
  sessionCmd
    .command("search <query>")
    .description("Search agent session transcripts globally or within a project/issue.")
    .option("--project <id>", "Restrict to a project ID")
    .option("--issue <n>", "Restrict to an issue number")
    .option("--provider <name>", "Filter by executor/provider (e.g. claude-code, codex)")
    .option("--status <name>", "Filter by issue status name (e.g. Done)")
    .option("--limit <n>", "Maximum results to return", "25")
    .option("--json", "Emit raw JSON (default)")
    .addHelpText("after", `
Examples:
  pnpm cli -- session search "ReferenceError"
  pnpm cli -- session search "pnpm install" --project <projectId> --limit 10
  pnpm cli -- session search "migration" --issue 42`)
    .action(async (query: string, options: { project?: string; issue?: string; provider?: string; status?: string; limit?: string; json?: boolean }) => {
      try {
        await runMigrations();

        const q = query.trim();
        if (q.length < 2) {
          console.log(JSON.stringify({ results: [], totalMatches: 0 }, null, 2));
          process.exit(0);
        }

        const limit = Math.min(Math.max(1, parseInt(options.limit ?? "25", 10) || 25), 100);
        const issueNumber = options.issue ? parseInt(options.issue, 10) : undefined;

        const SNIPPET_RADIUS = 80;
        const makeSnippet = (text: string, matchIdx: number): string => {
          const start = Math.max(0, matchIdx - SNIPPET_RADIUS);
          const end = Math.min(text.length, matchIdx + SNIPPET_RADIUS);
          let snippet = text.slice(start, end);
          if (start > 0) snippet = "..." + snippet;
          if (end < text.length) snippet += "...";
          return snippet;
        };

        const rows = await searchTranscriptMessages({
          q,
          projectId: options.project,
          issueNumber,
          statusFilter: options.status,
          providerFilter: options.provider,
          limit,
        });

        const results = rows.map((row) => {
          const data = row.messageData ?? "";
          const matchOffset = data.toLowerCase().indexOf(q.toLowerCase());
          return {
            messageId: row.messageId,
            sessionId: row.sessionId,
            providerSessionId: row.providerSessionId,
            snippet: makeSnippet(data, matchOffset >= 0 ? matchOffset : 0),
            matchOffset,
            messageCreatedAt: row.messageCreatedAt,
            projectId: row.projectId,
            projectName: row.projectName,
            issueId: row.issueId,
            issueNumber: row.issueNumber,
            issueTitle: row.issueTitle,
            issueStatusName: row.issueStatusName,
            workspaceId: row.workspaceId,
            branch: row.branch,
            sessionStartedAt: row.sessionStartedAt,
            sessionStatus: row.sessionStatus,
            executor: row.executor,
          };
        });

        console.log(JSON.stringify({ results, totalMatches: results.length }, null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── stats ────────────────────────────────────────────────────────────────────
  sessionCmd
    .command("stats [session-id]")
    .description("Get token usage, cost, and duration stats for a session.")
    .option("--workspace <id>", "Workspace ID — returns stats for the latest session in this workspace")
    .option("--json", "Emit raw JSON (default)")
    .addHelpText("after", `
Examples:
  pnpm cli -- session stats abc123
  pnpm cli -- session stats --workspace <workspaceId>`)
    .action(async (sessionId: string | undefined, options: { workspace?: string; json?: boolean }) => {
      try {
        await runMigrations();

        let targetSessionId = sessionId;

        if (!targetSessionId && options.workspace) {
          const latestId = await getLatestSessionIdForWorkspace(options.workspace);
          if (!latestId) {
            console.error("No sessions found for this workspace.");
            process.exit(1);
          }
          targetSessionId = latestId;
        }

        if (!targetSessionId) {
          console.error("Provide a session-id argument or --workspace <id>.");
          process.exit(1);
        }

        const session = await getSessionById(targetSessionId);

        if (!session) {
          console.error(`Session '${targetSessionId}' not found.`);
          process.exit(1);
        }

        if (!session.stats) {
          console.error(`No stats available for session ${targetSessionId} (session may still be running or stats were not captured).`);
          process.exit(1);
        }

        let stats: Record<string, unknown>;
        try {
          stats = JSON.parse(session.stats);
        } catch {
          console.error(`Invalid stats data for session ${targetSessionId}.`);
          process.exit(1);
        }

        console.log(JSON.stringify({
          sessionId: session.id,
          status: session.status,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          ...stats,
        }, null, 2));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── friction ─────────────────────────────────────────────────────────────────
  sessionCmd
    .command("friction")
    .description(
      "Aggregate agent-session friction (failed tool calls, repeated commands, error counts) across all sessions in a recent time window.\n" +
        "Reads persisted friction stats; run `session backfill-friction` first if coverage is low.",
    )
    .option("--project <id>", "Project ID (defaults to active project)")
    .option("--hours <n>", "Look-back window in hours", "48")
    .option("--json", "Emit raw JSON instead of a formatted report")
    .addHelpText("after", `
Examples:
  pnpm cli -- session friction
  pnpm cli -- session friction --hours 24 --json
  pnpm cli -- session friction --project <projectId>`)
    .action(async (options: { project?: string; hours?: string; json?: boolean }) => {
      try {
        await runMigrations();

        const windowHours = Math.max(1, parseInt(options.hours ?? "48", 10) || 48);
        const projectId = options.project ?? (await getActiveProjectId());

        const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

        // Reuses the insights session projection (same sessions+workspace+issue
        // join, window-scoped); this command only consumes each row's `.stats`.
        const rows = await getInsightsSessionRows(projectId, sinceIso);

        const byTool = new Map<string, { calls: number; failed: number }>();
        const repeated = new Map<string, { count: number; sessions: number }>();
        let totalToolCalls = 0;
        let failedToolCalls = 0;
        let errorTotal = 0;
        let sessionsWithFriction = 0;

        for (const r of rows) {
          if (!r.stats) continue;
          let parsed: { friction?: SessionFrictionStats };
          try { parsed = JSON.parse(r.stats); } catch { continue; }
          const f = parsed.friction;
          if (!f) continue;
          sessionsWithFriction++;
          totalToolCalls += f.totalToolCalls;
          failedToolCalls += f.failedToolCalls;
          errorTotal += f.errorCount;
          for (const t of f.tools ?? []) {
            const e = byTool.get(t.tool) ?? { calls: 0, failed: 0 };
            e.calls += t.count;
            e.failed += t.failedCount;
            byTool.set(t.tool, e);
          }
          for (const rc of f.repeatedCommands ?? []) {
            const e = repeated.get(rc.command) ?? { count: 0, sessions: 0 };
            e.count += rc.count;
            e.sessions += 1;
            repeated.set(rc.command, e);
          }
        }

        const result = {
          projectId,
          windowHours,
          sessionsInWindow: rows.length,
          sessionsWithFriction,
          coverage: rows.length > 0 ? Math.round((100 * sessionsWithFriction) / rows.length) / 100 : 0,
          totalToolCalls,
          failedToolCalls,
          failPct: totalToolCalls > 0 ? Math.round((100 * failedToolCalls) / totalToolCalls) : 0,
          errorTotal,
          byTool: [...byTool.entries()]
            .map(([tool, { calls, failed }]) => ({ tool, calls, failed, failPct: calls > 0 ? Math.round((100 * failed) / calls) : 0 }))
            .sort((a, b) => b.failed - a.failed || b.calls - a.calls)
            .slice(0, 20),
          topRepeatedCommands: [...repeated.entries()]
            .map(([command, { count, sessions: s }]) => ({ command, count, sessions: s }))
            .sort((a, b) => b.count - a.count || b.sessions - a.sessions)
            .slice(0, 15),
        };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          if (sessionsWithFriction === 0) {
            console.error(`\nNo friction stats found. Run: pnpm cli -- session backfill-friction --hours ${windowHours}`);
          }
          process.exit(0);
        }

        const L: string[] = [];
        L.push(`\n=== Fleet Friction — last ${windowHours}h (project ${projectId.slice(0, 8)}) ===`);
        L.push(`Sessions in window: ${result.sessionsInWindow}  |  with friction data: ${sessionsWithFriction}  |  coverage: ${(result.coverage * 100).toFixed(0)}%`);
        if (sessionsWithFriction === 0) {
          L.push(`\n(!) No friction stats found. Run: pnpm cli -- session backfill-friction --hours ${windowHours}`);
        } else {
          L.push(`\nTool calls: ${totalToolCalls}  |  failed: ${failedToolCalls}  (${result.failPct}%)  |  errors: ${errorTotal}`);
          L.push(`\n-- Top failing tools --`);
          if (result.byTool.length === 0) {
            L.push("  (none)");
          } else {
            for (const t of result.byTool.slice(0, 10)) {
              L.push(`  ${t.tool}: ${t.failed}/${t.calls} failed (${t.failPct}%)`);
            }
          }
          L.push(`\n-- Top repeated commands --`);
          if (result.topRepeatedCommands.length === 0) {
            L.push("  (none)");
          } else {
            for (const rc of result.topRepeatedCommands.slice(0, 10)) {
              L.push(`  [${rc.sessions} sessions, ${rc.count}×] ${rc.command.slice(0, 80)}`);
            }
          }
        }
        L.push("");
        console.log(L.join("\n"));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── find-similar ─────────────────────────────────────────────────────────────
  sessionCmd
    .command("find-similar <issue-number>")
    .description("Search the failure-pattern memory for past incidents similar to a given error text or issue description.")
    .option("--error <text>", "Error text or description to match (overrides issue description lookup)")
    .option("--limit <n>", "Maximum matches to return", "3")
    .option("--json", "Emit raw JSON instead of a formatted report")
    .addHelpText("after", `
Examples:
  pnpm cli -- session find-similar 42
  pnpm cli -- session find-similar 42 --error "ReferenceError: X is not defined" --limit 5`)
    .action(async (issueNumberStr: string, options: { error?: string; limit?: string; json?: boolean }) => {
      try {
        await runMigrations();

        const effectiveLimit = Math.min(Math.max(1, parseInt(options.limit ?? "3", 10) || 3), 10);

        let errorText = options.error ?? "";
        if (!errorText) {
          // Look up the issue description/title to use as query text
          const issueNum = parseInt(issueNumberStr, 10);
          if (isNaN(issueNum)) {
            console.error("Invalid issue number.");
            process.exit(1);
          }
          const issueRow = await getIssueTitleDescriptionByNumber(issueNum);
          if (!issueRow) {
            console.error(`Issue #${issueNum} not found.`);
            process.exit(1);
          }
          errorText = [issueRow.title, issueRow.description ?? ""].join(" ");
        }

        const queryKw = extractKeywords(errorText);
        if (queryKw.length === 0) {
          console.error("No meaningful keywords found in the error text.");
          process.exit(1);
        }

        const all = await getAllFailurePatterns();
        if (all.length === 0) {
          console.log("No failure patterns stored yet. Patterns are ingested from docs/learnings/ on startup.");
          process.exit(0);
        }

        const querySet = new Set(queryKw);
        const overlapScore = (patternKw: string[], qs: Set<string>): { score: number; matched: string[] } => {
          const matched = patternKw.filter(k => qs.has(k));
          if (patternKw.length === 0 && qs.size === 0) return { score: 0, matched: [] };
          const union = new Set([...patternKw, ...qs]);
          return { score: union.size > 0 ? matched.length / union.size : 0, matched };
        };

        const scored = all.map(p => {
          const patternKw = p.keywords ? p.keywords.split(" ").filter(Boolean) : [];
          const { score, matched } = overlapScore(patternKw, querySet);
          return { pattern: p, score, matchedKeywords: matched };
        })
          .filter(m => m.score > 0.05)
          .sort((a, b) => b.score - a.score)
          .slice(0, effectiveLimit);

        if (options.json) {
          console.log(JSON.stringify({ query: errorText, keywords: queryKw, matches: scored.map(m => ({ ...m.pattern, score: m.score, matchedKeywords: m.matchedKeywords })) }, null, 2));
          process.exit(0);
        }

        if (scored.length === 0) {
          console.log("No similar failures found. This may be a new class of error.");
          process.exit(0);
        }

        const lines = [
          `Found ${scored.length} similar failure(s) (keywords: ${queryKw.slice(0, 6).join(", ")}):`,
          "",
          ...scored.map((m, i) => {
            const p = m.pattern;
            const parts = [
              `## ${i + 1}. ${p.title} (${Math.round(m.score * 100)}% match)`,
              `**Matched keywords**: ${m.matchedKeywords.slice(0, 8).join(", ")}`,
            ];
            if (p.errorClass) parts.push(`**Error class**: ${p.errorClass}`);
            if (p.description) parts.push(`**Description**: ${p.description.slice(0, 300)}`);
            if (p.rootCause) parts.push(`**Root cause**: ${p.rootCause.slice(0, 400)}`);
            if (p.fix) parts.push(`**Fix**: ${p.fix.slice(0, 400)}`);
            if (p.sourceRef) parts.push(`**Source**: ${p.sourceRef}`);
            return parts.join("\n");
          }),
        ];
        console.log(lines.join("\n\n"));
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

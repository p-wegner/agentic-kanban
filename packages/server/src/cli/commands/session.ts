import type { Command } from "commander";
import { db } from "../../db/index.js";
import { issues, projectStatuses, workspaces, sessions, projects } from "@agentic-kanban/shared/schema";
import { eq, desc, gte, isNotNull, and } from "drizzle-orm";
import { parseSessionSummary, computeFrictionStats } from "@agentic-kanban/shared";
import { getCommitsForBranch } from "@agentic-kanban/shared/lib/git-service";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { getSessionMessageRows } from "../../repositories/session.repository.js";
import { computeReviewEffectiveness, renderReviewEffectivenessReport } from "../../services/review-effectiveness.service.js";

export function registerSessionCommand(program: Command) {
  const sessionCmd = program.command("session").description("Inspect agent sessions.\n\nSubcommands: analyze, recent, backfill-friction, review-effectiveness");

  sessionCmd
    .command("analyze <session-id>")
    .description("Show a consolidated analysis of a session: workspace, issue, parsed summary with tool patterns, stats, and errors.")
    .action(async (sessionId: string) => {
      try {
        await runMigrations();

        const sessionRows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        if (sessionRows.length === 0) {
          console.error(`Session '${sessionId}' not found.`);
          process.exit(1);
        }

        const session = sessionRows[0];

        const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1);
        const ws = wsRows[0] ?? null;

        let issue: Record<string, unknown> | null = null;
        if (ws) {
          const issueRows = await db
            .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, statusName: projectStatuses.name, priority: issues.priority, issueType: issues.issueType })
            .from(issues)
            .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
            .where(eq(issues.id, ws.issueId))
            .limit(1);
          issue = issueRows[0] ?? null;
        }

        const msgRows = await getSessionMessageRows(sessionId);

        const summary = parseSessionSummary(msgRows);

        let stats: Record<string, unknown> | null = null;
        if (session.stats) {
          try { stats = JSON.parse(session.stats); } catch { /* ignore */ }
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
            durationMs: (stats as any).durationMs ?? 0,
            totalCostUsd: (stats as any).totalCostUsd ?? 0,
            inputTokens: (stats as any).inputTokens ?? 0,
            outputTokens: (stats as any).outputTokens ?? 0,
            numTurns: (stats as any).numTurns ?? 1,
            model: (stats as any).model ?? summary.model,
            success: (stats as any).success ?? false,
            agentSummary: (stats as any).agentSummary,
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

        const rows = await db
          .select({
            sessionId: sessions.id,
            sessionStatus: sessions.status,
            startedAt: sessions.startedAt,
            endedAt: sessions.endedAt,
            executor: sessions.executor,
            triggerType: sessions.triggerType,
            workspaceId: workspaces.id,
            branch: workspaces.branch,
            wsStatus: workspaces.status,
            issueNumber: issues.issueNumber,
            issueTitle: issues.title,
          })
          .from(sessions)
          .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
          .innerJoin(issues, eq(workspaces.issueId, issues.id))
          .orderBy(desc(sessions.startedAt))
          .limit(limit);

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

        const whereClause = options.all
          ? isNotNull(sessions.endedAt)
          : and(
              isNotNull(sessions.endedAt),
              gte(
                sessions.startedAt,
                new Date(Date.now() - Math.max(1, parseInt(options.hours ?? "48", 10) || 48) * 60 * 60 * 1000).toISOString(),
              ),
            );

        const candidates = await db
          .select({ id: sessions.id, stats: sessions.stats })
          .from(sessions)
          .where(whereClause);

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
          await db.update(sessions).set({ stats: JSON.stringify(stats) }).where(eq(sessions.id, s.id));
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

        const report = await computeReviewEffectiveness({ projectId, sinceIso, deep: options.deep }, db);

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

        const projRows = await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, projectId)).limit(1);
        const repoPath = projRows[0]?.repoPath;
        if (!repoPath) {
          console.error(`Project '${projectId}' has no repoPath.`);
          process.exit(1);
        }

        const rows = await db
          .select({
            sessionId: sessions.id,
            triggerType: sessions.triggerType,
            executor: sessions.executor,
            startedAt: sessions.startedAt,
            endedAt: sessions.endedAt,
            workspaceId: workspaces.id,
            branch: workspaces.branch,
            wsStatus: workspaces.status,
            provider: workspaces.provider,
            baseCommitSha: workspaces.baseCommitSha,
            mergedHeadSha: workspaces.mergedHeadSha,
            mergedAt: workspaces.mergedAt,
            issueNumber: issues.issueNumber,
            issueTitle: issues.title,
          })
          .from(sessions)
          .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
          .innerJoin(issues, eq(workspaces.issueId, issues.id))
          .where(and(eq(issues.projectId, projectId), gte(sessions.startedAt, sinceIso)))
          .orderBy(sessions.startedAt);

        const classify = (t: string | null): "review" | "build" | "rework" | "noise" | "other" => {
          if (!t) return "build";
          if (t === "review" || t.startsWith("skill:code-review")) return "review";
          if (t.startsWith("skill:board-monitor") || t.startsWith("skill:board-navigator")) return "noise";
          if (t === "chat" || t === "fix-and-merge" || t === "fix-conflicts" || t === "plan-reject") return "rework";
          if (t === "verify" || t === "learning" || t === "bisect" || t === "reconcile") return "other";
          return "build";
        };

        // start/end are epoch-ms so we can compare against git author dates safely. git's %aI
        // carries a local tz offset (e.g. +02:00) while session timestamps are UTC 'Z' — string
        // comparison across the two is WRONG; only numeric instant comparison is correct.
        type Sess = { id: string; kind: ReturnType<typeof classify>; start: number; end: number };
        type WS = {
          workspaceId: string;
          issueNumber: number;
          issueTitle: string;
          provider: string | null;
          wsStatus: string;
          merged: boolean;
          baseCommitSha: string | null;
          headRef: string | null;
          sessions: Sess[];
          hasReview: boolean;
        };
        const byWs = new Map<string, WS>();
        const GRACE_MS = 2 * 60 * 1000; // a commit can land just after the session's recorded endedAt
        const nowMs = Date.now();

        for (const r of rows) {
          const kind = classify(r.triggerType);
          if (kind === "noise") continue;
          let ws = byWs.get(r.workspaceId);
          if (!ws) {
            ws = {
              workspaceId: r.workspaceId,
              issueNumber: r.issueNumber,
              issueTitle: r.issueTitle,
              provider: r.provider,
              wsStatus: r.wsStatus,
              merged: !!r.mergedAt,
              baseCommitSha: r.baseCommitSha,
              headRef: r.mergedHeadSha ?? r.branch,
              sessions: [],
              hasReview: false,
            };
            byWs.set(r.workspaceId, ws);
          }
          if (kind === "review") ws.hasReview = true;
          ws.sessions.push({
            id: r.sessionId,
            kind,
            start: new Date(r.startedAt).getTime(),
            end: r.endedAt ? new Date(r.endedAt).getTime() : nowMs,
          });
        }

        // Close open-ended session windows with the next session's start so windows don't overlap.
        for (const ws of byWs.values()) {
          ws.sessions.sort((a, b) => a.start - b.start);
          for (let i = 0; i < ws.sessions.length - 1; i++) {
            const next = ws.sessions[i + 1].start;
            if (ws.sessions[i].end > next) ws.sessions[i].end = next;
          }
        }

        // Every reviewed workspace is a candidate. The transcript method works on all of them;
        // the git method additionally needs a baseCommitSha + a reachable head.
        let targets = [...byWs.values()].filter((w) => w.hasReview);
        targets.sort((a, b) => a.issueNumber - b.issueNumber);
        const gitEligible = targets.filter((w) => w.baseCommitSha && w.headRef).length;
        if (limit > 0) targets = targets.slice(0, limit);

        type Result = {
          issue: number;
          title: string;
          provider: string | null;
          merged: boolean;
          wsStatus: string;
          gitResolved: boolean;
          implementerCommits: number;
          reviewerCommits: number;
          reviewerCommitsNamingIssue: number; // reviewer commit whose subject references THIS issue (#N / ak-N) — high confidence, filters cross-branch noise
          reworkCommits: number;
          unattributedCommits: number;
          reviewerCommitSubjects: string[];
          reviewSessionIds: string[];
          // deep (transcript) signals
          reviewEdited?: boolean;
          reviewCommitted?: boolean;
          reviewMentionedMajorCritical?: boolean;
          reviewFixedMajorCritical?: boolean;
        };
        const results: Result[] = [];

        // Strict attribution: a commit belongs to a session ONLY if its author-time falls
        // inside that session's [start, end+grace] window. No fallback — commits authored in
        // gaps between sessions, or rebased-in from master (their original author-time lies
        // outside every window of THIS workspace), are left unattributed on purpose. This is
        // what keeps base..tip's rebase pollution out of the implementer/reviewer tallies.
        const attribute = (commitDateIso: string, sess: Sess[]): Sess | null => {
          const t = new Date(commitDateIso).getTime();
          if (!Number.isFinite(t)) return null;
          for (const s of sess) {
            if (t >= s.start && t <= s.end + GRACE_MS) return s;
          }
          return null;
        };

        for (const ws of targets) {
          const commits = ws.baseCommitSha && ws.headRef ? await getCommitsForBranch(repoPath, ws.baseCommitSha, ws.headRef) : [];
          const res: Result = {
            issue: ws.issueNumber,
            title: ws.issueTitle.slice(0, 48),
            provider: ws.provider,
            merged: ws.merged,
            wsStatus: ws.wsStatus,
            gitResolved: commits.length > 0,
            implementerCommits: 0,
            reviewerCommits: 0,
            reviewerCommitsNamingIssue: 0,
            reworkCommits: 0,
            unattributedCommits: 0,
            reviewerCommitSubjects: [],
            reviewSessionIds: ws.sessions.filter((s) => s.kind === "review").map((s) => s.id),
          };
          const namesIssue = (msg: string) => {
            const m = msg.toLowerCase();
            return m.includes(`#${ws.issueNumber}`) || m.includes(`ak-${ws.issueNumber}`) || m.includes(`(${ws.issueNumber})`);
          };
          for (const c of commits) {
            const s = attribute(c.date, ws.sessions);
            const kind = s?.kind ?? null;
            if (kind === "review") {
              res.reviewerCommits++;
              if (namesIssue(c.message)) res.reviewerCommitsNamingIssue++;
              if (res.reviewerCommitSubjects.length < 5) res.reviewerCommitSubjects.push(c.message.slice(0, 60));
            } else if (kind === "rework") res.reworkCommits++;
            else if (kind === "build") res.implementerCommits++;
            else res.unattributedCommits++;
          }
          results.push(res);
        }

        // Deep transcript pass: per review session, did it change code / commit / cite MAJOR-CRITICAL.
        if (options.deep) {
          for (const res of results) {
            let edited = false, committed = false, majorCritical = false;
            for (const sid of res.reviewSessionIds) {
              const msgRows = await getSessionMessageRows(sid);
              const summary = parseSessionSummary(msgRows) as unknown as {
                agentSummary?: string;
                filesEdited?: string[];
                filesWritten?: string[];
                commandsRun?: string[];
              };
              if ((summary.filesEdited?.length ?? 0) > 0 || (summary.filesWritten?.length ?? 0) > 0) edited = true;
              if ((summary.commandsRun ?? []).some((c) => /git\s+commit/i.test(c))) committed = true;
              if (hasPositiveSeverity(summary.agentSummary ?? "")) majorCritical = true;
            }
            res.reviewEdited = edited;
            res.reviewCommitted = committed;
            res.reviewMentionedMajorCritical = majorCritical;
            res.reviewFixedMajorCritical = majorCritical && (edited || committed || res.reviewerCommits > 0);
          }
        }

        const gitResolved = results.filter((r) => r.gitResolved);
        const reviewerCommittedWs = gitResolved.filter((r) => r.reviewerCommits > 0);
        const highConfReviewerWs = gitResolved.filter((r) => r.reviewerCommitsNamingIssue > 0);
        const totalReviewerCommits = results.reduce((s, r) => s + r.reviewerCommits, 0);
        const totalImplCommits = results.reduce((s, r) => s + r.implementerCommits, 0);
        const totalReworkCommits = results.reduce((s, r) => s + r.reworkCommits, 0);
        const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

        const report: Record<string, unknown> = {
          window: { days, since: sinceIso, projectId, repoPath },
          scope: {
            reviewedWorkspacesInWindow: [...byWs.values()].filter((w) => w.hasReview).length,
            inspected: results.length,
            gitEligible,
            gitHistoryResolved: gitResolved.length,
            primaryMethod: options.deep ? "transcript (--deep)" : "git (run with --deep for the reliable transcript-based MAJOR/CRITICAL numbers)",
          },
          gitMethod: {
            caveat:
              "APPROXIMATE / lower bound. base..mergedHeadSha is polluted by the board's pre-merge rebases (stale baseCommitSha pulls in master commits), and mergedHeadSha is often null/unreachable. We strictly attribute a commit only when its author-time falls inside a review session's window, so this under-counts. Use --deep (transcript) as the source of truth.",
            workspacesWhereReviewerCommitted: reviewerCommittedWs.length,
            pctOfGitResolvedWhereReviewerCommitted: pct(reviewerCommittedWs.length, gitResolved.length),
            highConfidenceReviewerFixes: highConfReviewerWs.length,
            pctOfGitResolvedHighConfidence: pct(highConfReviewerWs.length, gitResolved.length),
            highConfidenceNote: "reviewer commit subject references its own issue (#N / ak-N) — filters out cross-branch attribution noise",
            totalReviewerCommits,
            totalImplementerCommits: totalImplCommits,
            totalReworkCommits,
            reviewerFixesThatMerged: reviewerCommittedWs.filter((r) => r.merged).length,
          },
        };

        if (options.deep) {
          const reviewEdited = results.filter((r) => r.reviewEdited);
          const reviewMajorCrit = results.filter((r) => r.reviewMentionedMajorCritical);
          const fixedMajorCrit = results.filter((r) => r.reviewFixedMajorCritical);
          // agreement between the two methods
          const bothAgreeFix = results.filter((r) => r.reviewerCommits > 0 && (r.reviewEdited || r.reviewCommitted)).length;
          const gitOnly = results.filter((r) => r.reviewerCommits > 0 && !(r.reviewEdited || r.reviewCommitted)).length;
          const sessionOnly = results.filter((r) => r.reviewerCommits === 0 && (r.reviewEdited || r.reviewCommitted)).length;
          report.deepMethod = {
            note: "Severity is a heuristic transcript scan; treat as approximate.",
            reviewsThatEditedCode: reviewEdited.length,
            reviewsCitingMajorOrCritical: reviewMajorCrit.length,
            reviewsThatFixedAMajorOrCriticalFinding: fixedMajorCrit.length,
            pctOfReviewedThatFixedMajorCritical: pct(fixedMajorCrit.length, results.length),
            fixedMajorCriticalIssues: fixedMajorCrit.map((r) => r.issue),
          };
          report.methodAgreement = { bothAgreeReviewerFixed: bothAgreeFix, gitOnly, sessionTranscriptOnly: sessionOnly };
        }

        report.perWorkspace = results.map((r) => ({
          issue: r.issue,
          title: r.title,
          provider: r.provider,
          implCommits: r.implementerCommits,
          reviewerCommits: r.reviewerCommits,
          reviewerCommitsNamingIssue: r.reviewerCommitsNamingIssue,
          reworkCommits: r.reworkCommits,
          merged: r.merged,
          ...(options.deep
            ? { reviewEdited: r.reviewEdited, reviewFixedMajorCritical: r.reviewFixedMajorCritical }
            : {}),
          reviewerCommitSubjects: r.reviewerCommitSubjects,
        }));

        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          process.exit(0);
        }

        const g = report.gitMethod as Record<string, number>;
        const L: string[] = [];
        L.push(`\n=== Reviewer-fixes analysis — last ${days}d (project ${projectId.slice(0, 8)}) ===`);
        L.push(`Reviewed workspaces in window: ${[...byWs.values()].filter((w) => w.hasReview).length}  |  inspected: ${results.length}  |  git-eligible: ${gitEligible}  |  git history resolved: ${gitResolved.length}`);
        if (options.deep) {
          const d = report.deepMethod as Record<string, unknown>;
          const m = report.methodAgreement as Record<string, number>;
          L.push(`\n-- TRANSCRIPT method [PRIMARY] (what each review session actually did) --`);
          L.push(`  Reviews that edited code themselves:      ${d.reviewsThatEditedCode}/${results.length}  (${pct(d.reviewsThatEditedCode as number, results.length)}%)`);
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
        L.push(`  Reviewer committed within a review window in:  ${reviewerCommittedWs.length}/${gitResolved.length} git-resolved workspaces  (${g.pctOfGitResolvedWhereReviewerCommitted}%)`);
        L.push(`  └ HIGH-CONFIDENCE (commit names its own issue, noise-filtered): ${highConfReviewerWs.length}/${gitResolved.length}  (${g.pctOfGitResolvedHighConfidence}%)`);
        L.push(`  Window-attributed commits by role:  implementer=${totalImplCommits}  reviewer=${totalReviewerCommits}  rework=${totalReworkCommits}`);
        L.push(`  Reviewer-fixed workspaces that merged: ${g.reviewerFixesThatMerged}/${reviewerCommittedWs.length}`);
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
}

/**
 * Heuristic: does the review text cite at least one CRITICAL/MAJOR finding that is
 * NOT negated? Reviewers very commonly write "No CRITICAL or MAJOR issues", so a raw
 * keyword match over-counts. We accept an occurrence only when the ~16 chars before it
 * contain no negation cue ("no", "zero", "0", "without", "not", "n't").
 */
function hasPositiveSeverity(text: string): boolean {
  if (!text) return false;
  const re = /\b(critical|major)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    if (!/\b(no|zero|without|not|n't)\b|0\s*$/.test(before)) return true;
  }
  return false;
}

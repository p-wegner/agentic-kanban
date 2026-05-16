import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, inArray, desc } from "drizzle-orm";
import { getDiffShortstat } from "../git-service.js";

const NOISE_PATTERNS = [
  /"subtype"\s*:\s*"api_retry"/,
  /"type"\s*:\s*"system".*"subtype"\s*:\s*"init"/,
];

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[mGKH]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseJsonLine(line: string): { type?: string; subtype?: string; message?: { content?: any[] }; result?: string; is_error?: boolean; summary?: string; status?: string } | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractMeaningfulOutput(
  messages: { type: string; data: string | null }[],
  maxLines: number,
): string[] {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.type !== "stdout" || !msg.data) continue;

    const cleaned = stripAnsi(msg.data);

    for (const rawLine of cleaned.split("\n")) {
      const trimmedLine = rawLine.trim();
      if (!trimmedLine) continue;

      if (NOISE_PATTERNS.some(p => p.test(trimmedLine))) continue;

      const obj = parseJsonLine(trimmedLine);

      if (obj) {
        if (obj.type === "assistant" && obj.message?.content) {
          const content = Array.isArray(obj.message.content) ? obj.message.content : [obj.message.content];
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              const text = block.text.trim().split("\n").pop() ?? "";
              if (text) lines.push(text.slice(0, 200));
            }
            if (block.type === "tool_use") {
              lines.push(`[tool] ${block.name}(${Object.keys(block.input || {}).join(", ")})`);
            }
          }
        }

        if (obj.type === "result") {
          const resultText = typeof obj.result === "string" ? obj.result : obj.subtype ?? "";
          if (resultText) {
            const trimmed = resultText.trim().split("\n").pop() ?? "";
            if (trimmed && trimmed !== "success") lines.push(trimmed.slice(0, 200));
          }
        }

        if (obj.type === "system" && obj.subtype === "task_notification") {
          const summary = obj.summary || obj.status || "";
          if (summary) lines.push(`[task] ${summary}`);
        }
      } else {
        if (trimmedLine.length > 2) {
          lines.push(trimmedLine.slice(0, 200));
        }
      }

      if (lines.length >= maxLines * 3) break;
    }

    if (lines.length >= maxLines * 3) break;
  }

  return lines.slice(0, maxLines);
}

export function registerGetBoardStatus(server: McpServer) {
  server.tool(
    "get_board_status",
    "Get a comprehensive overview of all active/in-progress items on the board. Shows per-issue: workspace state, session status, diff stats, token/cost usage, and last agent output. This is the single best query to answer 'what are my agents doing right now?'",
    {
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
      includeClosed: z.boolean().optional().describe("Include issues in Done/Cancelled status (default: false)"),
      tailLines: z.number().optional().describe("Number of meaningful output lines per issue (default: 5, max: 20)"),
    },
    async ({ projectId, includeClosed, tailLines }) => {
      const effectiveTailLines = Math.min(tailLines ?? 5, 20);

      try {
        // 1. Resolve project
        let pid = projectId;
        if (!pid) {
          const pref = await db
            .select({ value: schema.preferences.value })
            .from(schema.preferences)
            .where(eq(schema.preferences.key, "activeProjectId"))
            .limit(1);
          if (pref.length === 0) {
            return { content: [{ type: "text" as const, text: "No active project. Run `pnpm cli -- register <path>` first." }] };
          }
          pid = pref[0].value;
        }

        const projectRows = await db
          .select({ id: schema.projects.id, name: schema.projects.name, repoPath: schema.projects.repoPath, defaultBranch: schema.projects.defaultBranch })
          .from(schema.projects)
          .where(eq(schema.projects.id, pid))
          .limit(1);
        if (projectRows.length === 0) {
          return { content: [{ type: "text" as const, text: `Project ${pid} not found` }] };
        }
        const project = projectRows[0];

        // 2. Get statuses to identify terminal ones
        const statuses = await db
          .select({ id: schema.projectStatuses.id, name: schema.projectStatuses.name })
          .from(schema.projectStatuses)
          .where(eq(schema.projectStatuses.projectId, pid))
          .orderBy(schema.projectStatuses.sortOrder);
        const terminalStatusIds = new Set(
          statuses.filter(s => s.name === "Done" || s.name === "Cancelled").map(s => s.id),
        );

        // 3. Get issues with status names
        let projectIssues = await db
          .select({
            id: schema.issues.id,
            issueNumber: schema.issues.issueNumber,
            title: schema.issues.title,
            priority: schema.issues.priority,
            statusId: schema.issues.statusId,
            statusName: schema.projectStatuses.name,
          })
          .from(schema.issues)
          .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
          .where(eq(schema.issues.projectId, pid));

        if (!includeClosed) {
          projectIssues = projectIssues.filter(i => !terminalStatusIds.has(i.statusId));
        }

        if (projectIssues.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                project: { id: project.id, name: project.name, repoPath: project.repoPath, defaultBranch: project.defaultBranch },
                generatedAt: new Date().toISOString(),
                totals: { totalIssues: 0, inProgress: 0, activeWorkspaces: 0, runningSessions: 0 },
                issues: [],
              }, null, 2),
            }],
          };
        }

        const issueIds = projectIssues.map(i => i.id);

        // 4. Get workspaces for these issues
        const wsRows = await db.select().from(schema.workspaces)
          .where(inArray(schema.workspaces.issueId, issueIds));

        // 5. Get sessions for these workspaces
        const wsIds = wsRows.map(w => w.id);
        const sessionRows = wsIds.length > 0
          ? await db.select().from(schema.sessions).where(inArray(schema.sessions.workspaceId, wsIds))
          : [];

        // Group sessions by workspaceId (most recent first)
        const sessionsByWs = new Map<string, typeof sessionRows>();
        for (const s of sessionRows) {
          const arr = sessionsByWs.get(s.workspaceId) ?? [];
          arr.push(s);
          sessionsByWs.set(s.workspaceId, arr);
        }
        for (const [, arr] of sessionsByWs) {
          arr.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
        }

        // Group workspaces by issueId
        const wsByIssue = new Map<string, typeof wsRows>();
        for (const ws of wsRows) {
          const arr = wsByIssue.get(ws.issueId) ?? [];
          arr.push(ws);
          wsByIssue.set(ws.issueId, arr);
        }

        // 6. For each issue, assemble the overview
        const result: any[] = [];
        const asyncWork: Promise<void>[] = [];

        for (const issue of projectIssues) {
          const wsForIssue = wsByIssue.get(issue.id) ?? [];
          const mainWs = wsForIssue.sort((a, b) => {
            const p = (s: string) => s === "active" ? 0 : s === "reviewing" ? 1 : s === "idle" ? 2 : 3;
            return p(a.status) - p(b.status) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
          })[0] ?? null;

          const mainSessions = mainWs ? (sessionsByWs.get(mainWs.id) ?? []) : [];
          const latestSession = mainSessions[0] ?? null;

          let sessionStats: any = null;
          if (latestSession?.stats) {
            try {
              const p = JSON.parse(latestSession.stats);
              sessionStats = {
                durationMs: p.durationMs ?? 0,
                totalCostUsd: p.totalCostUsd ?? 0,
                inputTokens: p.inputTokens ?? 0,
                outputTokens: p.outputTokens ?? 0,
                numTurns: p.numTurns ?? 1,
                model: p.model ?? "",
                success: p.success ?? false,
              };
            } catch { /* ignore bad stats JSON */ }
          }

          const entry: any = {
            issueNumber: issue.issueNumber,
            issueId: issue.id,
            title: issue.title,
            priority: issue.priority,
            statusName: issue.statusName,
            workspace: mainWs ? {
              id: mainWs.id, branch: mainWs.branch, status: mainWs.status,
              workingDir: mainWs.workingDir, baseBranch: mainWs.baseBranch, isDirect: mainWs.isDirect,
            } : null,
            session: latestSession ? {
              id: latestSession.id, status: latestSession.status,
              startedAt: latestSession.startedAt, endedAt: latestSession.endedAt,
            } : null,
            sessionStats,
            diffStats: null,
            lastActivity: null,
            lastOutput: [],
          };

          // For non-closed workspaces with a workingDir: compute diff stats + last output
          if (mainWs && mainWs.workingDir && mainWs.status !== "closed") {
            const baseBranch = mainWs.baseBranch || project.defaultBranch;

            if (!mainWs.isDirect) {
              asyncWork.push(
                getDiffShortstat(mainWs.workingDir, baseBranch)
                  .then(stats => { entry.diffStats = stats; })
                  .catch(() => {}),
              );
            } else {
              asyncWork.push(
                getDiffShortstat(mainWs.workingDir, "HEAD")
                  .then(stats => { entry.diffStats = stats; })
                  .catch(() => {}),
              );
            }

            if (latestSession) {
              asyncWork.push(
                (async () => {
                  const msgs = await db
                    .select({ type: schema.sessionMessages.type, data: schema.sessionMessages.data, createdAt: schema.sessionMessages.createdAt })
                    .from(schema.sessionMessages)
                    .where(eq(schema.sessionMessages.sessionId, latestSession.id))
                    .orderBy(desc(schema.sessionMessages.id))
                    .limit(50);

                  if (msgs.length > 0 && msgs[0].createdAt) {
                    entry.lastActivity = msgs[0].createdAt;
                  }

                  entry.lastOutput = extractMeaningfulOutput(msgs.reverse(), effectiveTailLines);
                })(),
              );
            }
          }

          result.push(entry);
        }

        await Promise.all(asyncWork);

        const response = {
          project: { id: project.id, name: project.name, repoPath: project.repoPath, defaultBranch: project.defaultBranch },
          generatedAt: new Date().toISOString(),
          totals: {
            totalIssues: projectIssues.length,
            inProgress: projectIssues.filter(i => i.statusName === "In Progress" || i.statusName === "In Review").length,
            activeWorkspaces: wsRows.filter(w => w.status === "active" || w.status === "reviewing").length,
            runningSessions: sessionRows.filter(s => s.status === "running").length,
          },
          issues: result,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );
}

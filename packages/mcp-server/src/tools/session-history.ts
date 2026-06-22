import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface SessionResult {
  issueNum: number | null;
  dir: string;
  file: string;
  fileSizeBytes: number;
  lastModified: string;
  linesParsed: number;
  turns: number;
  lastAssistantText: string | null;
  lastToolCall: string | null;
  stopReason: string | null;
  sessionStarted: boolean;
  agentResponded: boolean;
  sessionId: string | null;
}

export function registerSessionHistory(server: McpServer) {
  server.tool(
    "session_history",
    "Inspect Claude Code session transcript files from ~/.claude/projects/ for worktrees linked to kanban issues. Shows what the agent did and why it stopped, without loading entire large files. Mirrors CLI `session-history [issue-number]`.",
    {
      issueNumber: z.number().int().positive().optional().describe("Filter to sessions for a specific issue number. Omit to list sessions for all issues."),
      tailLines: z.number().int().positive().optional().default(60).describe("Number of tail lines to parse per session file (default: 60)"),
      all: z.boolean().optional().default(false).describe("Show all session files for the issue, not just the most recent one"),
    },
    ({ issueNumber, tailLines = 60, all = false }) => {
      const claudeProjects = join(homedir(), ".claude", "projects");

      let allDirs: { name: string; path: string; issueNum: number | null }[] = [];
      try {
        const entries = readdirSync(claudeProjects);
        for (const entry of entries) {
          const m =
            entry.match(/--worktrees-feature-ak-(\d+)-/i) ||
            entry.match(/agentic-kanban-packages--worktrees-feature-ak-(\d+)-/i);
          const issueNum = m ? parseInt(m[1], 10) : null;
          if (m || entry.includes("worktrees")) {
            allDirs.push({ name: entry, path: join(claudeProjects, entry), issueNum });
          }
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot read ${claudeProjects}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      if (issueNumber !== undefined) {
        allDirs = allDirs.filter(d => d.issueNum === issueNumber);
        if (allDirs.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ issueNumber, results: [], message: `No session directory found for issue #${issueNumber}` }),
              },
            ],
          };
        }
      }

      allDirs.sort((a, b) => (a.issueNum ?? 999) - (b.issueNum ?? 999));

      const results: SessionResult[] = [];

      for (const dir of allDirs) {
        let jsonlFiles: { name: string; path: string; mtime: Date; size: number }[] = [];
        try {
          const files = readdirSync(dir.path).filter(f => f.endsWith(".jsonl"));
          for (const f of files) {
            const fp = join(dir.path, f);
            const st = statSync(fp);
            jsonlFiles.push({ name: f, path: fp, mtime: st.mtime, size: st.size });
          }
          jsonlFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        } catch {
          continue;
        }

        if (!all) jsonlFiles = jsonlFiles.slice(0, 1);

        for (const jf of jsonlFiles) {
          const raw = readFileSync(jf.path, "utf8");
          const allLines = raw.split("\n").filter(Boolean);
          const tailStart = Math.max(0, allLines.length - tailLines);
          const linesToParse = allLines.slice(tailStart);

          let turns = 0;
          let lastAssistantText: string | null = null;
          let lastToolCall: string | null = null;
          let stopReason: string | null = null;
          let sessionStarted = false;
          let agentResponded = false;
          let sessionId: string | null = null;

          for (const line of linesToParse) {
            let obj: Record<string, unknown>;
            try {
              obj = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (!sessionId && (obj.sessionId as string)) sessionId = obj.sessionId as string;

            const type = obj.type as string;
            if (type === "user") sessionStarted = true;

            if (type === "assistant") {
              agentResponded = true;
              const msg = obj.message as { role: string; stop_reason?: string; content?: unknown[] };
              if (msg.stop_reason) stopReason = msg.stop_reason;
              const content = msg.content ?? [];
              for (const block of content as { type: string; text?: string; name?: string; input?: unknown }[]) {
                if (block.type === "text" && block.text) {
                  lastAssistantText = block.text.replace(/\s+/g, " ").slice(0, 300);
                  turns++;
                }
                if (block.type === "tool_use" && block.name) {
                  const inputStr = block.input ? JSON.stringify(block.input).slice(0, 80) : "";
                  lastToolCall = `${block.name}  ${inputStr}`;
                }
              }
            }
          }

          results.push({
            issueNum: dir.issueNum,
            dir: dir.name,
            file: jf.name.replace(".jsonl", "").slice(0, 8) + "--",
            fileSizeBytes: jf.size,
            lastModified: jf.mtime.toISOString(),
            linesParsed: linesToParse.length,
            turns,
            lastAssistantText,
            lastToolCall,
            stopReason,
            sessionStarted,
            agentResponded,
            sessionId: sessionId ? (sessionId).slice(0, 8) + "--" : null,
          });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ tailLines, all, results }, null, 2),
          },
        ],
      };
    },
  );
}

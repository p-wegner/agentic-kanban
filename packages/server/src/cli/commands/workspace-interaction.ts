// Workspace CLI: inspection & agent-interaction subcommands (clarify / analyze-touched /
// terminal / comment-list / comment-add / handoff-bundle / approve-tool). Extracted
// verbatim from workspace.ts (#859 CLI god-file split); registered onto the same wsCmd so
// `pnpm cli -- workspace <sub>` is unchanged. CLI stays a thin transport (no inline db).
import type { Command } from "commander";
import type { DiffComment } from "@agentic-kanban/shared/types";
import { randomUUID } from "node:crypto";
import { getWorkspaceIssueContext } from "../../repositories/workspace.repository.js";
import { insertIssueComment } from "../../repositories/issue-comments.repository.js";
import { cliProposeTransition } from "../../services/workflow.service.js";
import { runMigrations } from "../shared.js";
import { buildWorkspaceApiUrl, buildApiUrl } from "./workspace-api-url.js";

export function registerWorkspaceInteractionCommands(wsCmd: Command) {
  wsCmd
    .command("clarify <workspace-id>")
    .description("Raise a clarifying question or propose the next workflow gate for a workspace.\n\nMirrors the clarify_or_propose MCP tool: action=clarify persists a structured question to the issue's activity thread (visible in the interactive UI on next refresh); action=propose advances the workspace's workflow gate. Operates directly on the database — no running server required.")
    .option("--action <action>", "Action: clarify or propose (default: clarify)", "clarify")
    .option("--question <text>", "The clarifying question to ask (for action=clarify)")
    .option("--header <text>", "Short header for the question (for action=clarify)")
    .option("--to <nodeName>", "Target workflow stage (for action=propose)")
    .option("--summary <text>", "Short context or transition summary")
    .option("--tests-passed", "Mark tests as passed for conditional propose routing")
    .option("--json", "Output raw JSON")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace clarify <workspace-id> --question "Should I update the tests?"
  $ agentic-kanban workspace clarify <workspace-id> --action propose --to Done --summary "Implementation complete"
`)
    .action(async (workspaceId: string, options: { action?: string; question?: string; header?: string; to?: string; summary?: string; testsPassed?: boolean; json?: boolean }) => {
      try {
        await runMigrations();
        const action = options.action ?? "clarify";
        if (action !== "clarify" && action !== "propose") {
          console.error(`Invalid --action '${action}'. Use clarify or propose.`);
          process.exit(1);
        }

        const ws = await getWorkspaceIssueContext(workspaceId);
        if (!ws) {
          console.error(`Workspace '${workspaceId}' not found.`);
          process.exit(1);
        }

        if (action === "clarify") {
          if (!options.question || !options.question.trim()) {
            console.error("--question is required for action=clarify.");
            process.exit(1);
          }
          const toolUseId = `cli-clarify-${randomUUID()}`;
          const question = { question: options.question.trim(), header: options.header, options: [{ label: "Answer in free text" }] };
          const body = [
            options.summary?.trim() || "The phase agent needs clarification before continuing.",
            "",
            `1. ${question.header ? `${question.header}: ` : ""}${question.question}`,
          ].join("\n");
          await insertIssueComment({
            issueId: ws.issueId,
            workspaceId,
            kind: "agent-question",
            author: "agent",
            body,
            payload: { toolUseId, questions: [question], source: "cli_clarify_or_propose" },
          });
          const result = { ok: true, action: "clarify", toolUseId, workspaceId, issueId: ws.issueId, issueNumber: ws.issueNumber, question };
          if (options.json) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
          console.log(`Clarifying question recorded for workspace '${workspaceId}' (issue #${ws.issueNumber}).`);
          console.log(`  toolUseId: ${toolUseId}`);
          console.log("  It is now visible in the interactive UI on next refresh.");
          process.exit(0);
        }

        const result = await cliProposeTransition(workspaceId, { to: options.to, summary: options.summary, testsPassed: options.testsPassed });
        if (!result.ok) {
          console.error(`Transition failed: ${result.error ?? "unknown error"}`);
          process.exit(1);
        }
        const next = (result.nextTransitions ?? []).map((t) => t.toNodeName);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, action: "propose", movedTo: result.toNode?.name, autoRouted: result.autoResolved ?? false, status: result.statusName, terminal: next.length === 0, nextStages: next }, null, 2));
          process.exit(0);
        }
        console.log(`Proposed transition for workspace '${workspaceId}'.`);
        if (result.toNode?.name) console.log(`  movedTo: ${result.toNode.name}`);
        if (result.statusName) console.log(`  status: ${result.statusName}`);
        console.log(next.length === 0 ? "  terminal: workflow complete" : `  nextStages: ${next.join(", ")}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("analyze-touched <issue-id>")
    .description("Predict which source files an issue will likely modify.\n\nUses a fast AI model for analysis. Results are cached on the issue. Requires the kanban server to be running (pnpm dev).")
    .option("--refresh", "Force re-analysis even if a cached result exists")
    .option("--json", "Output raw JSON response")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace analyze-touched <issue-id>
  $ agentic-kanban workspace analyze-touched <issue-id> --refresh
  $ agentic-kanban workspace analyze-touched <issue-id> --json
`)
    .action(async (issueId: string, options: { refresh?: boolean; json?: boolean; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildApiUrl(port, `/api/issues/${encodeURIComponent(issueId)}/analyze-touched-files`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh: options.refresh ?? false }),
        });
        const data = await res.json() as { error?: string; files?: string[] };

        if (!res.ok) {
          console.error(`Analyze failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (Array.isArray(data.files)) {
            console.log(`Predicted touched files (${data.files.length}):`);
            for (const f of data.files) console.log(`  ${f}`);
          } else {
            console.log(JSON.stringify(data, null, 2));
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("terminal <workspace-id>")
    .description("Read agent session output (terminal messages) for a workspace.\n\nReturns the last N messages, stripped of ANSI codes. Requires the kanban server to be running (pnpm dev).")
    .option("--limit <n>", "Number of most recent messages to return (default: 200, max: 2000)", "200")
    .option("--json", "Output raw JSON response")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace terminal <workspace-id>
  $ agentic-kanban workspace terminal <workspace-id> --limit 50
  $ agentic-kanban workspace terminal <workspace-id> --json
`)
    .action(async (workspaceId: string, options: { limit?: string; json?: boolean; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const limit = options.limit ?? "200";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "terminal"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: Number(limit) }),
        });
        const data = await res.json() as {
          error?: string;
          sessionStatus?: string;
          totalMessages?: number;
          returned?: number;
          messages?: Array<{ type: string; data?: string; exitCode?: number }>;
        };

        if (!res.ok) {
          console.error(`Terminal failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (data.sessionStatus) console.log(`Session status: ${data.sessionStatus}`);
          if (data.totalMessages !== undefined) console.log(`Messages: ${data.returned ?? "?"} of ${data.totalMessages}`);
          if (Array.isArray(data.messages)) {
            for (const msg of data.messages) {
              if (msg.type === "stdout" && msg.data) process.stdout.write(msg.data);
              else if (msg.type === "exit") console.log(`[exit: ${msg.exitCode ?? "?"}]`);
            }
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("comment-list <workspace-id>")
    .description("List diff review comments for a workspace.\n\nOptionally filter by file path. Requires the kanban server to be running (pnpm dev).")
    .option("--file <filePath>", "Filter comments by file path")
    .option("--json", "Output raw JSON response")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace comment-list <workspace-id>
  $ agentic-kanban workspace comment-list <workspace-id> --file src/index.ts
  $ agentic-kanban workspace comment-list <workspace-id> --json
`)
    .action(async (workspaceId: string, options: { file?: string; json?: boolean; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const url = options.file
          ? buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}/comments?filePath=${encodeURIComponent(options.file)}`)
          : buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}/comments`);
        const res = await fetch(url);
        const data = await res.json() as DiffComment[] | { error?: string };

        if (!res.ok) {
          console.error(`Comment list failed: ${(data as { error?: string }).error ?? res.statusText}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const comments: DiffComment[] = Array.isArray(data) ? data : [];
          if (comments.length === 0) {
            console.log("No comments found.");
          } else {
            console.log(`${comments.length} comment(s):`);
            for (const c of comments) {
              console.log(`  [${c.id}] ${c.filePath}:${c.lineNumNew ?? c.lineNumOld ?? "?"} — ${c.body}`);
              if (c.resolvedAt) console.log(`    (resolved at ${c.resolvedAt})`);
            }
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("comment-add <workspace-id>")
    .description("Add a review comment on a file in a workspace's diff.\n\nRequires the kanban server to be running (pnpm dev).")
    .option("--file <filePath>", "File path the comment is on (required)")
    .option("--body <text>", "Comment text (required)")
    .option("--line <n>", "Line number on the new side of the diff")
    .option("--line-old <n>", "Line number on the old (base) side of the diff")
    .option("--side <side>", "Which side of the diff: new or old (default: new)", "new")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace comment-add <workspace-id> --file src/index.ts --line 42 --body "Consider extracting this"
  $ agentic-kanban workspace comment-add <workspace-id> --file src/index.ts --body "General file comment"
`)
    .action(async (workspaceId: string, options: { file?: string; body?: string; line?: string; lineOld?: string; side?: string; port?: string }) => {
      try {
        if (!options.file) {
          console.error("--file is required");
          process.exit(1);
        }
        if (!options.body) {
          console.error("--body is required");
          process.exit(1);
        }

        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const payload: Record<string, unknown> = {
          filePath: options.file,
          body: options.body,
          side: options.side ?? "new",
        };
        if (options.line !== undefined) payload.lineNumNew = Number(options.line);
        if (options.lineOld !== undefined) payload.lineNumOld = Number(options.lineOld);

        const res = await fetch(buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}/comments`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json() as { id?: string; error?: string };

        if (!res.ok) {
          console.error(`Comment add failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Added comment on '${options.file}'`);
        console.log(`  id: ${data.id}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("handoff-bundle <workspace-id>")
    .description("Export a compact handoff bundle for a workspace.\n\nReturns workspace metadata, issue context, diff stats, agent summary, changed files, errors, and reviewer notes. Useful for stuck, awaiting-review, or human-transferred workspaces. Requires the kanban server to be running (pnpm dev).")
    .option("--format <format>", "Output format: json or markdown (default: json)", "json")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace handoff-bundle <workspace-id>
  $ agentic-kanban workspace handoff-bundle <workspace-id> --format markdown
`)
    .action(async (workspaceId: string, options: { format?: string; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const fmt = options.format === "markdown" ? "?format=markdown" : "";
        const res = await fetch(buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}/handoff-bundle${fmt}`));

        if (!res.ok) {
          let errorText = res.statusText;
          try {
            const errData = await res.json() as { error?: string };
            errorText = String(errData.error ?? res.statusText);
          } catch { /* ignore */ }
          console.error(`Handoff bundle failed: ${errorText}`);
          process.exit(1);
        }

        const text = await res.text();
        console.log(text);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("approve-tool <workspace-id>")
    .description("Create a pending tool-use approval request for a workspace session.\n\nRoutes the approval request to the agentic-kanban UI for user approval. Used by the approve_tool_use MCP tool flow. Requires the kanban server to be running (pnpm dev).")
    .option("--tool <toolName>", "The tool name to request approval for (required)")
    .option("--input <json>", "JSON-encoded tool input (default: {})", "{}")
    .option("--session <sessionId>", "The session ID requesting approval")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace approve-tool <workspace-id> --tool bash --input '{"command":"ls"}'
  $ agentic-kanban workspace approve-tool <workspace-id> --tool file_write --session <session-id>
`)
    .action(async (workspaceId: string, options: { tool?: string; input?: string; session?: string; port?: string }) => {
      try {
        if (!options.tool) {
          console.error("--tool is required");
          process.exit(1);
        }

        let toolInput: unknown = {};
        try {
          toolInput = JSON.parse(options.input ?? "{}");
        } catch {
          console.error("--input must be valid JSON");
          process.exit(1);
        }

        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildApiUrl(port, "/api/approvals"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: options.session ?? workspaceId,
            toolName: options.tool,
            toolInput,
          }),
        });
        const data = await res.json() as { id?: string; error?: string };

        if (!res.ok) {
          console.error(`Approve-tool failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Created approval request`);
        console.log(`  id: ${data.id}`);
        console.log(`  tool: ${options.tool}`);
        console.log(`  Check the board UI to approve or deny.`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prodDeps, type ToolDeps } from "./deps.js";
import { boardApi, boardErrorText, mcpJson, mcpText } from "../board-call.js";
import { notifyBoard } from "../notify.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { resolveActiveProjectId } from "../db-utils.js";

/**
 * Ticket groups (#661): the backlog-consolidation entry point for agents. Delegates to
 * the board's `/api/issues/group-scan` route because the scan runs a server-side LLM
 * pass; applying writes `coupled_with` edges only (non-destructive — the destructive
 * alternative is `contract_coupled_issues`). The monitor's auto-group start then runs
 * each group as ONE workspace: one agent, one review, one merge-gate run.
 */
export function registerProposeTicketGroups(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "propose_ticket_groups",
    "Scan a project's open Backlog/Todo tickets and propose ticket GROUPS — sets of granular tickets that share a code surface and should be implemented together in ONE workspace (one agent, one review, one merge-gate run). Preview by default; pass apply=true to write the coupled_with edges the monitor's group-start consumes. Non-destructive: every ticket keeps its identity (contrast contract_coupled_issues, which merges and cancels). mode='touched-files' (default) is a deterministic, no-LLM-call scan over cached predicted files (#918) — the right default for a cold backlog with no coupled_with edges yet; mode='llm' runs the AI consolidation pass over an established backlog instead.",
    {
      projectId: z.string().optional().describe("Project to scan (defaults to the active project)"),
      apply: z.boolean().optional().describe("Write the proposed coupled_with edges (default: preview only)"),
      mode: z.enum(["llm", "touched-files"]).optional().describe("'touched-files' (default): deterministic, no LLM call, seeded from cached predicted files. 'llm': AI consolidation pass."),
    },
    async ({ projectId, apply, mode }) => {
      try {
        const resolved = await resolveActiveProjectId(db, schema, projectId);
        if (!resolved.ok) return resolved.error;
        const resolvedProjectId = resolved.projectId;
        const { ok, statusText, data: raw } = await boardApi(`/api/issues/group-scan`, {
          method: "POST",
          body: JSON.stringify({ projectId: resolvedProjectId, apply: apply === true, mode: mode ?? "touched-files" }),
        });
        if (!ok) {
          return mcpText(`Group scan failed: ${boardErrorText(raw, statusText)}`);
        }
        if (apply === true) {
          notifyBoard(resolvedProjectId, "mcp_propose_ticket_groups");
        }
        return mcpJson(raw);
      } catch (err) {
        return mcpText(`Group scan failed: ${errorMessage(err)}`);
      }
    },
  );
}

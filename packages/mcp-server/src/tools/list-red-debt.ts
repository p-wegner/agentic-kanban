import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText, mcpUnreachable } from "../board-call.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { resolveActiveProjectId } from "../db-utils.js";

/**
 * #915 — the red-debt ledger. Thin pass-through to `GET /api/red-debt`, following the same
 * shape as `registerListWorkers`: no second implementation of the ledger here.
 */
export function registerListRedDebt(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "list_red_debt",
    "List a project's red-debt ledger: suites known red on the base branch (suite, since-commit, attributed/owner issue, flaky|real tag, opened/resolved). This is the durable record a fast/sprint train's PASS-WITH-DEBT verdict checks against — a failing suite already in this ledger no longer blocks the train; a suite absent from it is new red and still blocks. Open-only by default.",
    {
      projectId: z.string().optional().describe("Project ID (defaults to the active project)"),
      includeResolved: z.boolean().optional().describe("Include closed (resolved) entries too. Default: open-only."),
    },
    async ({ projectId, includeResolved }) => {
      const rpid = await resolveActiveProjectId(db, schema, projectId);
      if (!rpid.ok) return rpid.error;
      const params = new URLSearchParams({ projectId: rpid.projectId });
      if (includeResolved) params.set("includeResolved", "true");
      try {
        const { ok, statusText, data } = await boardApi(`/api/red-debt?${params}`);
        if (!ok) return mcpText(`Failed to list red debt: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}

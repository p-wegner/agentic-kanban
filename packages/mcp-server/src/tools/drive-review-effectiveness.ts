import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText } from "../board-call.js";
import { eq } from "drizzle-orm";
import { mcpStructuredError } from "../db-utils.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * drive_review_effectiveness — mirror of CLI `drive review-effectiveness <drive-id>`.
 *
 * Calls GET /api/projects/:projectId/drives/:id/review-effectiveness.
 * The projectId is resolved from the drive record in the DB (same as the CLI),
 * or can be passed explicitly.
 */
export function registerDriveReviewEffectiveness(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "drive_review_effectiveness",
    "Get AI code-review effectiveness metrics for a Drive: reviews run, reviews that bounced a ticket back to building, " +
      "and tickets merged without any review. Scoped to the drive's time window and — when the drive has a meta-issue — " +
      "to that meta-issue's dependency subtree (pass wholeProject=true to ignore the subtree restriction). " +
      "Mirrors CLI `drive review-effectiveness <drive-id>`.",
    {
      driveId: z.string().describe("The drive ID"),
      projectId: z
        .string()
        .optional()
        .describe(
          "Project ID. Resolved automatically from the drive record when omitted — only pass this to override.",
        ),
      wholeProject: z
        .boolean()
        .optional()
        .describe(
          "Ignore the meta-issue subtree restriction and scope to the whole project within the drive's time window. Default false.",
        ),
      deep: z
        .boolean()
        .optional()
        .describe(
          "Also load each review session's transcript and classify its self-reported verdict (approve vs changes-requested). Slower. Default false.",
        ),
    },
    async ({ driveId, projectId, wholeProject, deep }) => {
      // 1. Resolve projectId from the drive record if not supplied
      let pid = projectId;
      if (!pid) {
        const driveRows = await db
          .select({ projectId: schema.drives.projectId })
          .from(schema.drives)
          .where(eq(schema.drives.id, driveId))
          .limit(1);
        if (driveRows.length === 0) {
          return mcpStructuredError("DRIVE_NOT_FOUND", `Drive '${driveId}' not found.`);
        }
        pid = driveRows[0].projectId;
      }

      // 2. Call the REST endpoint
      const params = new URLSearchParams();
      if (wholeProject) params.set("wholeProject", "true");
      if (deep) params.set("deep", "true");
      const qs = params.toString() ? `?${params.toString()}` : "";

      try {
        const { ok, status, statusText, data } = await boardApi(
          `/api/projects/${encodeURIComponent(pid)}/drives/${encodeURIComponent(driveId)}/review-effectiveness${qs}`,
        );

        if (!ok) {
          return mcpStructuredError("REQUEST_FAILED", boardErrorText(data, statusText), { status });
        }

        return mcpJson(data);
      } catch (err) {
        return mcpText(`Request failed: ${errorMessage(err)}`);
      }
    },
  );
}

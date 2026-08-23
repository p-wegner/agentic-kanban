/**
 * `add_comment` — append a note or a question to a ticket's comment thread (#799).
 *
 * WHY IT DID NOT EXIST. #769 asked for it and closed without it: the registry had
 * `create_diff_comment` (which needs a workspace plus a file and a line, i.e. a review comment on
 * a diff, not a note on a ticket) and `update_issue` (which can also move status, so handing it
 * to a builder hands it the board's workflow). So an agent's only channel for "here is where I
 * got to" was its own final output — fine for a host session the board reads directly, useless
 * for a REMOTE fleet builder whose progress the operator cannot see until the session ends.
 *
 * WHY IT POSTS OVER THE BOARD API RATHER THAN INSERTING. `issue_comments` has exactly ONE write
 * path — `insertIssueComment` in the server's repository — because that is where the #738
 * identical-repeat collapse lives, and that collapse is what kept a chatty writer from growing
 * the table to 99,797 rows. This package cannot import the server's repository, and a second raw
 * insert here would silently opt out of the rule for the one caller most likely to repeat itself.
 * `POST /api/issues/:id/comments` goes through that path, so the property stays a property of the
 * table.
 *
 * KINDS. The route's own whitelist already refuses `preflight-verdict` and `gate-decision` —
 * records of a MACHINE decision that a caller posting would be forging. This tool narrows further
 * to `note` and `agent-question`, the two things an agent legitimately authors in its own voice.
 * The fleet MCP bridge narrows to the same pair independently (`REMOTE_COMMENT_KINDS`), so a
 * remote builder is pinned by the proxy as well as by this schema.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText, mcpUnreachable } from "../board-call.js";

/** The kinds an AGENT may author. A strict subset of the route's `userPostableKinds`. */
export const AGENT_POSTABLE_COMMENT_KINDS = ["note", "agent-question"] as const;

export function registerAddComment(server: McpServer) {
  server.tool(
    "add_comment",
    "Append a comment to an issue's thread — a progress note, or a question you need answered. " +
      "Use this to reflect what you have done or learned onto the ticket itself, instead of " +
      "leaving it only in your final output. Does not change the issue's status.",
    {
      issueId: z.string().describe("The issue ID (UUID) to comment on"),
      body: z.string().describe("Comment text (markdown)"),
      kind: z
        .enum(AGENT_POSTABLE_COMMENT_KINDS)
        .optional()
        .describe("'note' (default) for progress, 'agent-question' when you need an answer"),
      workspaceId: z.string().optional().describe("Workspace this note belongs to, when there is one"),
    },
    async ({ issueId, body, kind, workspaceId }) => {
      if (!body.trim()) return mcpText("body is required");
      try {
        const { ok, data, statusText } = await boardApi(`/api/issues/${issueId}/comments`, {
          method: "POST",
          body: JSON.stringify({
            body,
            kind: kind ?? "note",
            // Not "user": the board's timeline distinguishes who spoke, and an agent
            // signing as a human is the same forgery the kind whitelist exists to stop.
            author: "agent",
            ...(workspaceId ? { workspaceId } : {}),
          }),
        });
        if (!ok) return mcpText(`Failed to add comment: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}

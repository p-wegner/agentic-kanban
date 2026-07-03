import { fireWebhook } from "@agentic-kanban/shared/lib";
import { resolveOutboundWebhookUrl } from "@agentic-kanban/shared/lib/issue-status-orchestration";
import type { Database } from "../db/index.js";
import type { WebhookIssueStatusPayload } from "@agentic-kanban/shared/lib";
import type { WebhookSender } from "./issue.service.js";

export function createWebhookSender(database: Database): WebhookSender {
  return (projectId: string, payload: WebhookIssueStatusPayload): void => {
    // Fire-and-forget: resolve the configured URL then send. The pref-key
    // derivation + loopback validation live in the shared orchestration seam
    // (#974), shared with the MCP move/update tools. Errors are silently ignored.
    resolveOutboundWebhookUrl(database, projectId)
      .then((url) => {
        if (url) fireWebhook(url, payload);
      })
      .catch(() => {
        // Best-effort
      });
  };
}

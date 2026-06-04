import { getPreference } from "../repositories/preferences.repository.js";
import { validateWebhookUrl, fireWebhook } from "@agentic-kanban/shared/lib";
import type { Database } from "../db/index.js";
import type { WebhookIssueStatusPayload } from "@agentic-kanban/shared/lib";
import type { WebhookSender } from "./issue.service.js";

export function createWebhookSender(database: Database): WebhookSender {
  return (projectId: string, payload: WebhookIssueStatusPayload): void => {
    // Fire-and-forget: read the URL then send. Errors are silently ignored.
    getPreference(`outbound_webhook_url_${projectId}`, database)
      .then((raw) => {
        const url = validateWebhookUrl(raw);
        if (url) fireWebhook(url, payload);
      })
      .catch(() => {
        // Best-effort
      });
  };
}

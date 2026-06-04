/**
 * Local outbound webhook: fires a POST to a configured localhost/127.0.0.1 URL
 * whenever an issue changes status. Non-loopback hosts are rejected to honour
 * the local-only constraint.
 */

export interface WebhookIssueStatusPayload {
  event: "issue.status_changed";
  issueId: string;
  issueNumber: number | null;
  title: string;
  projectId: string;
  newStatusId: string;
  newStatusName: string | null;
  statusChangedAt: string;
}

/** Returns the trimmed URL if valid and loopback, or null otherwise. */
export function validateWebhookUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return null;
  return trimmed;
}

/**
 * Fire-and-forget POST to the configured webhook URL.
 * Silently swallowed on any error — webhooks are best-effort.
 */
export function fireWebhook(url: string, payload: WebhookIssueStatusPayload): void {
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Best-effort — caller never waits
  });
}

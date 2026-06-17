/**
 * Builds the opening message for a "Chat about this ticket" butler session
 * (kanban issue #838).
 *
 * The button on a ticket opens the butler with this message pre-filled, giving
 * the butler the ticket's context and steering it toward the typical
 * retrospective questions — what took so long, where the agents failed, what
 * context was missing, and how to improve the agent harness. The butler can pull
 * the full transcript itself via its MCP tools (`get_session_transcript`,
 * `get_issue`, …); we only need to hand it the ticket reference and the prompt.
 */

export interface TicketChatContext {
  issueNumber: number | null;
  title: string;
  description?: string | null;
  statusName?: string;
  issueType?: string;
}

/** Trim an issue description so a long body doesn't dominate the opening turn. */
function truncateDescription(description: string, max = 1200): string {
  const trimmed = description.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/**
 * Compose the pre-filled butler message for chatting about a ticket.
 * Always references the ticket by `#<number>` when available so the butler's
 * MCP lookups resolve the right issue.
 */
export function buildTicketChatPrompt(ctx: TicketChatContext): string {
  const ref = ctx.issueNumber != null ? `#${ctx.issueNumber}` : `"${ctx.title}"`;
  const lines: string[] = [];

  lines.push(`Let's talk about ticket ${ref}: ${ctx.title}.`);

  const meta: string[] = [];
  if (ctx.issueType) meta.push(`Type: ${ctx.issueType}`);
  if (ctx.statusName) meta.push(`Status: ${ctx.statusName}`);
  if (meta.length) lines.push(meta.join(" · "));

  const desc = ctx.description?.trim();
  if (desc) {
    lines.push("");
    lines.push("Ticket description:");
    lines.push(truncateDescription(desc));
  }

  lines.push("");
  lines.push(
    "I'd like to understand how the work on this ticket went. Pull up the ticket " +
      "and its agent transcript (you have MCP tools for this) and help me dig in. " +
      "Typical things I want to know:",
  );
  lines.push("- What took so long, and how could it have been faster?");
  lines.push("- Where did the agents fail or get stuck?");
  lines.push("- What context was missing that would have helped?");
  lines.push("- How could we improve the agent harness, skills, or instructions?");
  lines.push("");
  lines.push("Start with a short summary of what happened, then we'll go deeper.");

  return lines.join("\n");
}

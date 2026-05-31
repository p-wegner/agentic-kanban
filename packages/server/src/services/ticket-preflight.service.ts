import { eq, and, inArray } from "drizzle-orm";
import { isTerminalStatusIdView } from "@agentic-kanban/shared";
import { issues, projectStatuses, workflowNodes } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import { NotFoundError } from "../errors/index.js";

export type PreflightVerdict = "ready" | "needs-clarification" | `duplicate-of-#${number}` | `blocked-by-#${number}`;

export interface TicketPreflightResult {
  verdict: PreflightVerdict;
  /** Concrete questions to answer before the agent starts (when verdict = needs-clarification) */
  questions: string[];
  /** Human-readable summary of why the verdict was reached */
  summary: string;
  /** Issue number this ticket duplicates (when verdict starts with duplicate-of-#) */
  duplicateOfNumber?: number;
  /** Issue number that blocks this ticket (when verdict starts with blocked-by-#) */
  blockedByNumber?: number;
  /** True when the ticket looks like a non-trivial / multi-file feature (not a tiny quick edit).
   *  Used to warn against running it in a direct workspace (which edits the main checkout in place). */
  looksComplex: boolean;
}

/** A question + the answer the user provided during preflight clarification. */
export interface PreflightClarification {
  question: string;
  answer: string;
}

/** Render answered clarifications as a markdown block — reused for the prompt re-check
 *  and as the comment body / agent-context injection. */
export function formatClarificationsBlock(clarifications: PreflightClarification[]): string {
  const lines: string[] = ["## Clarifications from preflight", ""];
  for (const c of clarifications) {
    lines.push(`**Q:** ${c.question.trim()}`);
    lines.push(`**A:** ${c.answer.trim()}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export async function runTicketPreflight(
  issueId: string,
  projectId: string,
  database: Database,
  clarifications?: PreflightClarification[],
): Promise<TicketPreflightResult> {
  const issueRows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);

  if (issueRows.length === 0) {
    throw new NotFoundError("Issue not found");
  }

  const target = issueRows[0];

  // Fetch open issues (excluding Done/Cancelled) as duplicate/conflict candidates
  const doneOrCancelledStatuses = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(
      and(
        eq(projectStatuses.projectId, projectId),
        inArray(projectStatuses.name, ["Done", "Cancelled"]),
      ),
    );
  const excludeIds = doneOrCancelledStatuses.map((s) => s.id);

  const allProjectIssues = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
      statusId: issues.statusId,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));
  const terminalStatusIds = new Set(excludeIds);
  const openIssues = allProjectIssues.filter((issue) => !isTerminalStatusIdView(issue, terminalStatusIds));

  const answeredClarifications = (clarifications ?? []).filter(
    (c) => c.question?.trim() && c.answer?.trim(),
  );

  const otherIssues = openIssues.filter((i) => i.id !== issueId);
  const issuesSummary = otherIssues.length > 0
    ? otherIssues
      .map((i) => `  #${i.issueNumber ?? "?"} ${i.title}${i.description ? ` — ${i.description.split("\n")[0].slice(0, 120)}` : ""}`)
      .join("\n")
    : "(no other open issues)";

  const prompt = `You are a pre-flight ticket reviewer for an AI coding agent.
Your job is to catch under-specified, duplicate, or conflicting tickets BEFORE the agent wastes tokens on them.

Evaluate the ticket below and return a JSON verdict. Be strict but fair — agents need clear acceptance criteria.

Verdict options (choose exactly one):
- "ready": ticket is clear, actionable, and has no conflicts; agent can start immediately
- "needs-clarification": ticket is ambiguous, missing acceptance criteria, or under-specified
- "duplicate-of-#N": this ticket is substantially the same as open issue #N (use the exact issue number)
- "blocked-by-#N": this ticket cannot start until open issue #N is completed first (use the exact issue number)

For "needs-clarification", list 1-5 concrete questions the user must answer before the agent starts.
Questions should be specific and answerable (not vague like "can you clarify?").

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "verdict": "ready|needs-clarification|duplicate-of-#N|blocked-by-#N",
  "questions": ["question 1", "..."],
  "summary": "one sentence explaining your verdict",
  "duplicateOfNumber": null,
  "blockedByNumber": null,
  "looksComplex": false
}

Rules:
- duplicateOfNumber / blockedByNumber: set to the integer issue number (not the string) when relevant, otherwise null
- questions: always an array (empty when verdict is not needs-clarification)
- A ticket with just a title and no description is NOT automatically needs-clarification — a clear title may be enough for small tasks
- Only flag as needs-clarification for genuine ambiguity that would cause the agent to guess wrong
- Only flag as duplicate-of / blocked-by when you're confident, not just topically similar
- looksComplex: true when this is a non-trivial feature — touches multiple files/components, has several acceptance criteria, or involves new functionality / refactors. false for tiny, quick, single-spot edits (typo, copy tweak, one-line fix, small config change). This is independent of the verdict.

Target ticket: #${target.issueNumber ?? "?"} "${target.title}"
${target.description ? `Description:\n${target.description.trim()}` : "(no description)"}
${answeredClarifications.length > 0 ? `\nThe user has already answered these clarifying questions — treat them as part of the spec when judging readiness:\n${answeredClarifications.map((c) => `Q: ${c.question.trim()}\nA: ${c.answer.trim()}`).join("\n")}\n` : ""}
Other open issues on the board:
${issuesSummary}`;

  const stdout = await invokeClaudePrompt(prompt, { database, model: "claude-haiku-4-5" });
  const cleaned = stdout.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as {
    verdict?: string;
    questions?: unknown[];
    summary?: string;
    duplicateOfNumber?: number | null;
    blockedByNumber?: number | null;
    looksComplex?: boolean;
  };

  const rawVerdict = (parsed.verdict ?? "ready").trim();
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    : [];
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";

  let verdict: PreflightVerdict;
  if (rawVerdict === "ready" || rawVerdict === "needs-clarification") {
    verdict = rawVerdict;
  } else if (rawVerdict.startsWith("duplicate-of-#")) {
    verdict = rawVerdict as PreflightVerdict;
  } else if (rawVerdict.startsWith("blocked-by-#")) {
    verdict = rawVerdict as PreflightVerdict;
  } else {
    // Fallback if AI returns something unexpected
    verdict = "ready";
  }

  const duplicateOfNumber = typeof parsed.duplicateOfNumber === "number" ? parsed.duplicateOfNumber : undefined;
  const blockedByNumber = typeof parsed.blockedByNumber === "number" ? parsed.blockedByNumber : undefined;
  const looksComplex = parsed.looksComplex === true;

  return { verdict, questions, summary, duplicateOfNumber, blockedByNumber, looksComplex };
}

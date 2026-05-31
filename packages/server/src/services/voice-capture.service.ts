import { randomUUID } from "node:crypto";
import { issues, issueTags, tags, projectStatuses } from "@agentic-kanban/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import type { BoardEvents } from "./board-events.js";
import { getOutgoingTransitions, syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";

export interface VoiceCaptureInput {
  projectId: string;
  transcript: string;
  speechLanguage?: string | null;
  speechLanguageLabel?: string | null;
}

export interface VoiceCaptureIssueResult {
  type: "issue";
  issueId: string;
  issueNumber: number;
  title: string;
  description: string;
  priority: string;
}

export interface VoiceCaptureActionResult {
  type: "action";
  action: "move_issue";
  issueId: string;
  issueNumber: number;
  title: string;
  targetStatus: string;
  message: string;
}

export type VoiceCaptureResult = VoiceCaptureIssueResult | VoiceCaptureActionResult;

export class VoiceCaptureCommandError extends Error {
  constructor(message: string) {
    super(message);
  }
}

type VoiceCommandIntent =
  | { type: "create_issue" }
  | { type: "move_issue"; issueNumber: number; targetStatus: string };

function cleanCommandText(value: string): string {
  return value
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVoiceCommandIntent(transcript: string): VoiceCommandIntent {
  const text = cleanCommandText(transcript);
  const moveMatch = /^(?:please\s+)?(?:move|put|send)\s+(?:(?:issue|ticket)(?:\s+number)?\s+)?#?\s*(\d+)\s+(?:to|into)(?:\s+(.*))?$/i.exec(text);
  if (moveMatch) {
    return {
      type: "move_issue",
      issueNumber: Number(moveMatch[1]),
      targetStatus: cleanCommandText(moveMatch[2] ?? "").replace(/^(?:the\s+)?/i, ""),
    };
  }
  return { type: "create_issue" };
}

function cleanLanguageMetadata(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim().slice(0, 80);
  return cleaned || null;
}

function cleanLanguageCode(value: string | null | undefined): string | null {
  const cleaned = cleanLanguageMetadata(value);
  if (!cleaned) return null;
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(cleaned) ? cleaned : null;
}

function cleanLanguageLabel(value: string | null | undefined): string | null {
  const cleaned = cleanLanguageMetadata(value);
  if (!cleaned) return null;
  return /^[A-Za-z0-9][A-Za-z0-9 .()/-]{0,79}$/.test(cleaned) ? cleaned : null;
}

function formatSpeechLanguageContext(
  speechLanguage?: string | null,
  speechLanguageLabel?: string | null,
): string {
  const languageCode = cleanLanguageCode(speechLanguage);
  const languageLabel = cleanLanguageLabel(speechLanguageLabel);

  if (!languageCode) {
    return "\nSpeech recognition language: browser auto/default.";
  }

  const label = languageLabel || languageCode;
  return `\nSpeech recognition language: ${label} (${languageCode}).`;
}

function fallbackStructuredTranscript(transcript: string): { title: string; description: string; priority: string } {
  return {
    title: transcript.slice(0, 80),
    description: `Voice captured: ${transcript}`,
    priority: "medium",
  };
}

/**
 * Find or create the `voice-capture` tag for the given database.
 * Returns the tag id.
 */
async function ensureVoiceCaptureTag(database: Database): Promise<string> {
  const TAG_NAME = "voice-capture";
  const existing = await database
    .select({ id: tags.id })
    .from(tags)
    .where(sql`lower(${tags.name}) = lower(${TAG_NAME})`)
    .limit(1);
  if (existing[0]) return existing[0].id;
  const id = randomUUID();
  await database.insert(tags).values({
    id,
    name: TAG_NAME,
    color: "#8b5cf6",
    createdAt: new Date().toISOString(),
  });
  return id;
}

/**
 * Resolve the Backlog statusId for a project. Falls back to the default status
 * when no "Backlog" status exists.
 */
async function resolveBacklogStatusId(projectId: string, database: Database): Promise<string> {
  const rows = await database
    .select({ id: projectStatuses.id, name: projectStatuses.name, isDefault: projectStatuses.isDefault })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
  const backlog = rows.find((r) => r.name.toLowerCase() === "backlog");
  if (backlog) return backlog.id;
  const def = rows.find((r) => r.isDefault) ?? rows[0];
  if (!def) throw new Error("No statuses configured for project");
  return def.id;
}

function normalizeStatusName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findTargetStatus(
  targetStatus: string,
  statuses: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const wanted = targetStatus.trim();
  const normalized = normalizeStatusName(wanted);
  const exact = statuses.find((s) => s.name.toLowerCase() === wanted.toLowerCase())
    ?? statuses.find((s) => normalizeStatusName(s.name) === normalized);
  if (exact) return exact;

  if (normalized === "review") {
    return statuses.find((s) => normalizeStatusName(s.name) === "inreview")
      ?? statuses.find((s) => normalizeStatusName(s.name).includes("review"))
      ?? null;
  }

  return statuses.find((s) => normalizeStatusName(s.name).includes(normalized)) ?? null;
}

async function moveIssueFromVoiceCommand(
  projectId: string,
  intent: Extract<VoiceCommandIntent, { type: "move_issue" }>,
  database: Database,
  boardEvents?: BoardEvents,
): Promise<VoiceCaptureActionResult> {
  const issueRows = await database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, currentNodeId: issues.currentNodeId })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issueNumber, intent.issueNumber)))
    .limit(1);
  const issue = issueRows[0];
  if (!issue) throw new VoiceCaptureCommandError(`Issue #${intent.issueNumber} not found`);
  if (!intent.targetStatus.trim()) {
    throw new VoiceCaptureCommandError("Target status is required for move commands");
  }

  const statusRows = await database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
  const target = findTargetStatus(intent.targetStatus, statusRows);
  if (!target) {
    throw new VoiceCaptureCommandError(`Status '${intent.targetStatus}' not found. Available: ${statusRows.map((s) => s.name).join(", ")}`);
  }

  if (issue.currentNodeId) {
    const transitions = await getOutgoingTransitions(database, issue.currentNodeId);
    const reachable = transitions.some(
      (transition) => transition.toStatusName === target.name
        || transition.toStatusName?.toLowerCase() === target.name.toLowerCase(),
    );
    if (transitions.length > 0 && !reachable) {
      const validNames = transitions
        .map((transition) => transition.toStatusName ?? transition.toNodeName)
        .filter(Boolean)
        .join(", ");
      throw new VoiceCaptureCommandError(
        `Transition to "${target.name}" is not a valid next step from the current workflow stage. Valid next stages: ${validNames || "(none - terminal stage)"}.`,
      );
    }
  }

  const now = new Date().toISOString();
  await database
    .update(issues)
    .set({ statusId: target.id, statusChangedAt: now, updatedAt: now })
    .where(eq(issues.id, issue.id));
  await syncCurrentNodeToStatus(database, issue.id).catch(() => {});

  boardEvents?.broadcast(projectId, "issue_updated");

  return {
    type: "action",
    action: "move_issue",
    issueId: issue.id,
    issueNumber: intent.issueNumber,
    title: issue.title,
    targetStatus: target.name,
    message: `Moved #${intent.issueNumber}: ${issue.title} to ${target.name}`,
  };
}

/**
 * Parses a free-form voice transcript into a structured ticket using Claude.
 */
async function parseTranscript(
  transcript: string,
  database: Database,
  speechLanguage?: string | null,
  speechLanguageLabel?: string | null,
): Promise<{ title: string; description: string; priority: string }> {
  const languageContext = formatSpeechLanguageContext(speechLanguage, speechLanguageLabel);

  // Use a clear delimiter instead of quoting the transcript to prevent prompt injection.
  const prompt = `You are a project manager assistant. A developer spoke the following voice note while coding. Structure it into a clean kanban ticket.${languageContext}

<voice_transcript>
${transcript}
</voice_transcript>

Rules:
- title: concise, action-oriented, ≤80 chars
- description: expand with context, acceptance criteria, and implementation hints. Include a "## Voice Transcript" section at the end (collapsed context) with the verbatim transcript.
- priority: one of "low", "medium", "high", "critical" — infer from urgency words in the transcript

- If the transcript is not English, write the title and description in the same language as the transcript unless the speaker clearly asks otherwise.

Respond ONLY with valid JSON (no markdown, no explanation):
{"title": "...", "description": "...", "priority": "medium"}`;

  let stdout: string;
  try {
    stdout = await invokeClaudePrompt(prompt, { database, model: "claude-haiku-4-5" });
  } catch (err) {
    console.warn("[voice-capture] AI structuring failed; creating issue from raw transcript:", err);
    return fallbackStructuredTranscript(transcript);
  }
  const cleaned = stdout.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed: { title?: string; description?: string; priority?: string };
  try {
    parsed = JSON.parse(cleaned) as { title?: string; description?: string; priority?: string };
  } catch {
    // Claude returned non-JSON (e.g. explanation text). Fall back to raw transcript.
    return fallbackStructuredTranscript(transcript);
  }

  const parsedPriority = parsed.priority?.trim().toLowerCase();
  const priority = parsedPriority === "urgent"
    ? "critical"
    : ["low", "medium", "high", "critical"].includes(parsedPriority ?? "")
    ? parsedPriority!
    : "medium";

  return {
    title: parsed.title?.trim() || transcript.slice(0, 80),
    description: parsed.description?.trim() || `Voice captured: ${transcript}`,
    priority,
  };
}

export async function createVoiceCaptureIssue(
  input: VoiceCaptureInput,
  database: Database,
  boardEvents?: BoardEvents,
): Promise<VoiceCaptureResult> {
  const { projectId, transcript, speechLanguage, speechLanguageLabel } = input;
  const intent = parseVoiceCommandIntent(transcript);
  if (intent.type === "move_issue") {
    return moveIssueFromVoiceCommand(projectId, intent, database, boardEvents);
  }

  const [structured, statusId, tagId] = await Promise.all([
    parseTranscript(transcript, database, speechLanguage, speechLanguageLabel),
    resolveBacklogStatusId(projectId, database),
    ensureVoiceCaptureTag(database),
  ]);

  // Determine next issue number
  const maxRow = await database
    .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
    .from(issues)
    .where(eq(issues.projectId, projectId));
  const issueNumber = (maxRow[0]?.maxNum ?? 0) + 1;

  const id = randomUUID();
  const now = new Date().toISOString();

  await database.insert(issues).values({
    id,
    issueNumber,
    title: structured.title,
    description: structured.description,
    priority: structured.priority,
    issueType: "task",
    skipAutoReview: false,
    estimate: null,
    sortOrder: 0,
    workflowTemplateId: null,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  // Attach the voice-capture tag
  await database.insert(issueTags).values({
    id: randomUUID(),
    issueId: id,
    tagId,
  });

  boardEvents?.broadcast(projectId, "issue_created");

  return { type: "issue", issueId: id, issueNumber, title: structured.title, description: structured.description, priority: structured.priority };
}

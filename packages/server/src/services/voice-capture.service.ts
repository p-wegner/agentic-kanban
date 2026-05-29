import { randomUUID } from "node:crypto";
import { issues, issueTags, tags, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import type { BoardEvents } from "./board-events.js";

export interface VoiceCaptureInput {
  projectId: string;
  transcript: string;
}

export interface VoiceCaptureResult {
  issueId: string;
  issueNumber: number;
  title: string;
  description: string;
  priority: string;
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

/**
 * Parses a free-form voice transcript into a structured ticket using Claude.
 */
async function parseTranscript(
  transcript: string,
  database: Database,
): Promise<{ title: string; description: string; priority: string }> {
  const prompt = `You are a project manager assistant. A developer spoke the following voice note while coding. Structure it into a clean kanban ticket.

Voice transcript: "${transcript}"

Rules:
- title: concise, action-oriented, ≤80 chars
- description: expand with context, acceptance criteria, and implementation hints. Include a "## Voice Transcript" section at the end (collapsed context) with the verbatim transcript.
- priority: one of "low", "medium", "high", "urgent" — infer from urgency words in the transcript

Respond ONLY with valid JSON (no markdown, no explanation):
{"title": "...", "description": "...", "priority": "medium"}`;

  const stdout = await invokeClaudePrompt(prompt, { database, model: "claude-haiku-4-5" });
  const cleaned = stdout.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as { title?: string; description?: string; priority?: string };

  const validPriorities = ["low", "medium", "high", "urgent"];
  const priority = validPriorities.includes(parsed.priority ?? "") ? (parsed.priority as string) : "medium";

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
  const { projectId, transcript } = input;

  const [structured, statusId, tagId] = await Promise.all([
    parseTranscript(transcript, database),
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
    createdAt: now,
  });

  boardEvents?.broadcast(projectId, "issue_created");

  return { issueId: id, issueNumber, title: structured.title, description: structured.description, priority: structured.priority };
}

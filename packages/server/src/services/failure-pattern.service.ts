/**
 * Failure-pattern memory service.
 *
 * Maintains a `failure_patterns` table populated from:
 *   1. `docs/learnings/*.md` files in the project repo (backfilled on startup).
 *   2. Closed/failed sessions that are manually tagged `incident`.
 *
 * On agent exit with non-zero code, the last 50 stderr lines are matched against
 * stored patterns using keyword-overlap scoring, and a board comment is posted
 * for the top matches.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import { db as realDb } from "../db/index.js";
import { failurePatterns, sessionMessages } from "@agentic-kanban/shared/schema";
import { extractKeywords } from "@agentic-kanban/shared";
import { eq, desc } from "drizzle-orm";

export interface FailurePattern {
  id: string;
  title: string;
  errorClass: string | null;
  keywords: string;
  description: string | null;
  rootCause: string | null;
  fix: string | null;
  sourceType: string;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PatternMatch {
  pattern: FailurePattern;
  score: number;
  matchedKeywords: string[];
}

function overlapScore(aKw: string[], bKw: Set<string>): { score: number; matched: string[] } {
  const matched = aKw.filter(k => bKw.has(k));
  if (aKw.length === 0 && bKw.size === 0) return { score: 0, matched: [] };
  const union = new Set([...aKw, ...bKw]);
  const score = matched.length / union.size;
  return { score, matched };
}

// ---------------------------------------------------------------------------
// Markdown parser — extracts structured fields from a learning doc
// ---------------------------------------------------------------------------

function parseMarkdownPattern(content: string, filePath: string): Omit<FailurePattern, "id" | "createdAt" | "updatedAt"> | null {
  const lines = content.split(/\r?\n/);

  // Title: first H1
  const titleLine = lines.find(l => l.startsWith("# "));
  if (!titleLine) return null;
  const title = titleLine.replace(/^#\s+/, "").trim();

  // Extract sections
  const sections: Record<string, string> = {};
  let currentSection = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      if (currentSection) sections[currentSection.toLowerCase()] = currentLines.join("\n").trim();
      currentSection = h2Match[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentSection) sections[currentSection.toLowerCase()] = currentLines.join("\n").trim();

  // Try to detect an error class from common patterns in the text
  const fullText = content;
  const errorClassMatch = fullText.match(/\b(SyntaxError|TypeError|ReferenceError|MODULE_NOT_FOUND|SQLITE_BUSY|SQLITE_CORRUPT|ECONNREFUSED|ENOENT|ENOMEM|ERR_[A-Z_]+|BOM|smart.quote|conflict.marker)\b/i);
  const errorClass = errorClassMatch ? errorClassMatch[1] : null;

  const rootCause = sections["root cause"] || sections["the root cause beneath most of these"] || sections["root causes"] || null;
  const fix = sections["fix"] || sections["recovery procedure (proven this session)"] || sections["fixes filed"] || sections["what worked"] || null;
  const description = sections["what went wrong (in the order we hit it)"] || sections["problem"] || sections["background"] || null;

  const keywords = extractKeywords([title, content.slice(0, 2000)].join(" ")).join(" ");

  return {
    title,
    errorClass,
    keywords,
    description: description?.slice(0, 2000) ?? null,
    rootCause: rootCause?.slice(0, 1000) ?? null,
    fix: fix?.slice(0, 1000) ?? null,
    sourceType: "learning",
    sourceRef: filePath,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Ingest a single learning .md file into the DB. Skips if already ingested (by sourceRef). */
export async function ingestLearningFile(filePath: string, db: Database = realDb): Promise<boolean> {
  const content = await readFile(filePath, "utf-8").catch(() => null);
  if (!content) return false;

  const parsed = parseMarkdownPattern(content, filePath);
  if (!parsed) return false;

  // Skip if already ingested
  const existing = await db
    .select({ id: failurePatterns.id })
    .from(failurePatterns)
    .where(eq(failurePatterns.sourceRef, filePath))
    .limit(1);
  if (existing.length > 0) return false;

  const now = new Date().toISOString();
  await db.insert(failurePatterns).values({
    id: randomUUID(),
    ...parsed,
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

/** Backfill from all .md files in a learnings directory. Idempotent. */
export async function backfillFromLearnings(learningsDir: string, db: Database = realDb): Promise<number> {
  if (!existsSync(learningsDir)) return 0;

  let files: string[];
  try {
    files = await readdir(learningsDir);
  } catch {
    return 0;
  }

  const mdFiles = files.filter(f => f.endsWith(".md"));
  let count = 0;
  for (const f of mdFiles) {
    try {
      const ingested = await ingestLearningFile(resolve(learningsDir, f), db);
      if (ingested) count++;
    } catch (err) {
      console.warn(`[failure-patterns] failed to ingest ${f}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return count;
}

/** Create a pattern directly (for incident-tagged issues). */
export async function createPattern(
  data: Pick<FailurePattern, "title" | "errorClass" | "description" | "rootCause" | "fix" | "sourceType" | "sourceRef">,
  db: Database = realDb,
): Promise<FailurePattern> {
  const now = new Date().toISOString();
  const id = randomUUID();
  const keywords = extractKeywords([data.title, data.description ?? "", data.rootCause ?? "", data.fix ?? ""].join(" ")).join(" ");
  const row = { id, keywords, createdAt: now, updatedAt: now, ...data };
  await db.insert(failurePatterns).values(row);
  return row as FailurePattern;
}

/**
 * Find patterns similar to the given error text.
 * Uses keyword overlap scoring — appropriate for the small set of patterns.
 */
export async function findSimilarFailures(
  errorText: string,
  limit = 3,
  db: Database = realDb,
): Promise<PatternMatch[]> {
  const queryKw = extractKeywords(errorText);
  if (queryKw.length === 0) return [];

  const all = await db.select().from(failurePatterns);
  if (all.length === 0) return [];

  const querySet = new Set(queryKw);

  const scored: PatternMatch[] = all.map(p => {
    const patternKw = p.keywords ? p.keywords.split(" ").filter(Boolean) : [];
    const { score, matched } = overlapScore(patternKw, querySet);
    return { pattern: p as FailurePattern, score, matchedKeywords: matched };
  });

  return scored
    .filter(m => m.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Extract the last N lines from session stderr messages. */
export async function extractSessionStderr(sessionId: string, maxLines = 50, db: Database = realDb): Promise<string> {
  const msgs = await db
    .select({ type: sessionMessages.type, data: sessionMessages.data })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.id))
    .limit(maxLines * 2);

  const stderrLines = msgs
    .filter(m => m.type === "stderr" && m.data)
    .slice(0, maxLines)
    .reverse()
    .map(m => m.data ?? "");

  return stderrLines.join("\n");
}

/** List all stored failure patterns (for API/MCP). */
export async function listPatterns(db: Database = realDb): Promise<FailurePattern[]> {
  return db.select().from(failurePatterns) as Promise<FailurePattern[]>;
}

/** Delete a pattern by ID. */
export async function deletePattern(id: string, db: Database = realDb): Promise<void> {
  await db.delete(failurePatterns).where(eq(failurePatterns.id, id));
}

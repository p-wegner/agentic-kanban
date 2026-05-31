import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, like, sql } from "drizzle-orm";
import { issueArtifacts, issues, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

const PHASE_FILES: Record<string, string> = {
  specify: "spec.md",
  spec: "spec.md",
  design: "design.md",
  tasks: "tasks.md",
};

const PHASE_ORDER = ["phase-artifact:specify", "phase-artifact:spec", "phase-artifact:design", "phase-artifact:tasks"];

function phaseKeyFromCaption(caption: string | null | undefined): string | null {
  const prefix = "phase-artifact:";
  if (!caption?.startsWith(prefix)) return null;
  const key = caption.slice(prefix.length).trim().toLowerCase();
  return PHASE_FILES[key] ? key : null;
}

function phaseFileNameFromCaption(caption: string | null | undefined): string | null {
  const key = phaseKeyFromCaption(caption);
  return key ? PHASE_FILES[key] : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "issue";
}

function artifactRelativePath(issueNumber: number | null, title: string, caption: string): string | null {
  const fileName = phaseFileNameFromCaption(caption);
  if (!fileName) return null;
  const issuePart = issueNumber == null ? "issue" : String(issueNumber);
  return `specs/${issuePart}-${slugify(title)}/${fileName}`;
}

async function writeArtifactFile(workingDir: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = join(workingDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
}

export async function materializePhaseArtifactToWorktree(
  database: Database,
  input: {
    issueId: string;
    workspaceId: string | null | undefined;
    caption: string | null | undefined;
    content: string;
  },
): Promise<{ relativePath: string | null }> {
  if (!input.workspaceId || !phaseFileNameFromCaption(input.caption)) return { relativePath: null };

  const rows = await database
    .select({
      issueNumber: issues.issueNumber,
      title: issues.title,
      workingDir: workspaces.workingDir,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.issueId, input.issueId)))
    .limit(1);

  const row = rows[0];
  if (!row?.workingDir || !input.caption) return { relativePath: null };

  const relativePath = artifactRelativePath(row.issueNumber, row.title, input.caption);
  if (!relativePath) return { relativePath: null };

  await writeArtifactFile(row.workingDir, relativePath, input.content);
  return { relativePath };
}

export async function materializeLatestPhaseArtifactForWorkspace(
  database: Database,
  workspaceId: string,
  phaseName: string | null | undefined,
): Promise<{ relativePath: string | null; artifactId: string | null }> {
  const key = phaseName?.trim().toLowerCase();
  const fileName = key ? PHASE_FILES[key] : null;
  if (!key || !fileName) return { relativePath: null, artifactId: null };
  const caption = `phase-artifact:${key}`;

  const workspaceRows = await database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const issueId = workspaceRows[0]?.issueId;
  if (!issueId) return { relativePath: null, artifactId: null };

  const artifactRows = await database
    .select({
      id: issueArtifacts.id,
      content: issueArtifacts.content,
      caption: issueArtifacts.caption,
    })
    .from(issueArtifacts)
    .where(and(
      eq(issueArtifacts.issueId, issueId),
      eq(issueArtifacts.workspaceId, workspaceId),
      eq(issueArtifacts.type, "text"),
      eq(issueArtifacts.caption, caption),
    ))
    .orderBy(sql`${issueArtifacts.createdAt} DESC`)
    .limit(1);

  const artifact = artifactRows[0];
  if (!artifact) return { relativePath: null, artifactId: null };

  const result = await materializePhaseArtifactToWorktree(database, {
    issueId,
    workspaceId,
    caption: artifact.caption,
    content: artifact.content,
  });
  return { relativePath: result.relativePath, artifactId: artifact.id };
}

export async function buildPhaseArtifactsContext(
  database: Database,
  issueId: string,
  workspaceId?: string | null,
): Promise<string> {
  const conditions = [
    eq(issueArtifacts.issueId, issueId),
    eq(issueArtifacts.type, "text"),
    like(issueArtifacts.caption, "phase-artifact:%"),
  ];
  if (workspaceId) conditions.push(eq(issueArtifacts.workspaceId, workspaceId));

  const rows = await database
    .select({
      caption: issueArtifacts.caption,
      content: issueArtifacts.content,
      createdAt: issueArtifacts.createdAt,
    })
    .from(issueArtifacts)
    .where(and(...conditions))
    .orderBy(issueArtifacts.createdAt);

  const latest = new Map<string, { caption: string; content: string; createdAt: string }>();
  for (const row of rows) {
    if (!row.caption || !phaseFileNameFromCaption(row.caption)) continue;
    latest.set(row.caption, { caption: row.caption, content: row.content, createdAt: row.createdAt });
  }
  const ordered = [...latest.values()].sort((a, b) => {
    const ai = PHASE_ORDER.indexOf(a.caption);
    const bi = PHASE_ORDER.indexOf(b.caption);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.createdAt.localeCompare(b.createdAt);
  });
  if (ordered.length === 0) return "";

  const lines = ["## Approved Phase Artifacts", ""];
  for (const artifact of ordered) {
    const fileName = phaseFileNameFromCaption(artifact.caption);
    if (!fileName) continue;
    const content = artifact.content.length > 4_000
      ? `${artifact.content.slice(0, 4_000)}\n\n_(artifact truncated)_`
      : artifact.content;
    lines.push(`### ${fileName}`, "", "```markdown", content.trim(), "```", "");
  }
  return lines.join("\n").trim();
}

export async function isImplementWorkflowNode(database: Database, nodeId: string | null | undefined): Promise<boolean> {
  if (!nodeId) return false;
  const rows = await database
    .select({ name: workflowNodes.name })
    .from(workflowNodes)
    .where(eq(workflowNodes.id, nodeId))
    .limit(1);
  return rows[0]?.name?.trim().toLowerCase() === "implement";
}

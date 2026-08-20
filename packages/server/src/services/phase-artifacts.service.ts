import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Database } from "../db/index.js";
import {
  getLatestPhaseArtifact,
  getPhaseArtifactRows,
  getWorkflowNodeName,
  getWorkspaceArtifactTarget,
  getWorkspaceIssueId,
} from "../repositories/phase-artifacts.repository.js";
import { slugify } from "@agentic-kanban/shared/lib/slugify";
import { adoptLegacySlugPath, legacySlugify } from "@agentic-kanban/shared/lib/slug-path-compat";

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

function issueSlug(value: string): string {
  return slugify(value, { maxLength: 60, fallback: "issue" });
}

/**
 * The same slug under the PRE-#565 rule (#682), so a spec DIRECTORY written before the slug
 * consolidation is adopted rather than orphaned beside its replacement. Measured moves:
 * `"Über-Ticket"` → `ber-ticket` → `uber-ticket`; `"Straße"` → `stra-e` → `strasse`; and a title
 * whose 60-char cap landed mid-run lost its trailing dash, so pure-ASCII titles moved too.
 */
function legacyIssueSlug(value: string): string {
  return legacySlugify(value, { maxLength: 60, fallback: "issue" });
}

function artifactRelativePath(issueNumber: number | null, title: string, caption: string): string | null {
  const fileName = phaseFileNameFromCaption(caption);
  if (!fileName) return null;
  const issuePart = issueNumber == null ? "issue" : String(issueNumber);
  return `specs/${issuePart}-${issueSlug(title)}/${fileName}`;
}

/** The directory this issue's artifacts lived in before #565 changed the slug rule (#682). */
export function legacyArtifactDir(issueNumber: number | null, title: string): string {
  const issuePart = issueNumber == null ? "issue" : String(issueNumber);
  return `specs/${issuePart}-${legacyIssueSlug(title)}`;
}

/** The directory they live in now. */
export function currentArtifactDir(issueNumber: number | null, title: string): string {
  const issuePart = issueNumber == null ? "issue" : String(issueNumber);
  return `specs/${issuePart}-${issueSlug(title)}`;
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

  const row = await getWorkspaceArtifactTarget(input.workspaceId, input.issueId, database);
  if (!row?.workingDir || !input.caption) return { relativePath: null };

  const relativePath = artifactRelativePath(row.issueNumber, row.title, input.caption);
  if (!relativePath) return { relativePath: null };

  // #682: the whole spec DIRECTORY moved when #565 changed the slug rule, so earlier phase
  // artifacts for this same issue (plan.md written before, tasks.md written after) would end up
  // split across two dirs with nothing saying so. Adopt the old dir before writing; a no-op
  // whenever the slug is unchanged, which is every ASCII title short of the cap.
  const adoption = adoptLegacySlugPath(
    join(row.workingDir, currentArtifactDir(row.issueNumber, row.title)),
    join(row.workingDir, legacyArtifactDir(row.issueNumber, row.title)),
  );
  if (adoption.adopted) {
    console.log(`[phase-artifacts] adopted pre-#565 spec dir ${adoption.from} for issue #${row.issueNumber ?? "?"} (slug rule changed in #565)`);
  }

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

  const issueId = await getWorkspaceIssueId(workspaceId, database);
  if (!issueId) return { relativePath: null, artifactId: null };

  const artifact = await getLatestPhaseArtifact(issueId, workspaceId, caption, database);
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
  const rows = await getPhaseArtifactRows(issueId, workspaceId, database);

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
  const name = await getWorkflowNodeName(nodeId, database);
  return name?.trim().toLowerCase() === "implement";
}

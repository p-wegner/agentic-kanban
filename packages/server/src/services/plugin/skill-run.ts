import { pluginSkillName, type PluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../../db/index.js";
import type { PluginRow } from "../../repositories/plugins.repository.js";
import { PluginError } from "../plugin-errors.js";
import type { CreateIssueInput, CreateIssueResult } from "../issue.service.js";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "../workspace-internals.js";
import { resolveWorkflowTemplateId } from "./workflow-resolution.js";

/**
 * Launching an AGENTIC (judgment-requiring) plugin skill against a project — the counterpart to
 * `runScript` for the manifest's `skills` entries, which cannot be a deterministic subprocess
 * (e.g. `prd-consolidation` reads and translates analysis docs, it doesn't just shell out).
 *
 * It creates a ticket carrying the skill's brief, then launches a workspace against it exactly
 * like the board's own "New Workspace" flow — so it inherits the project's Strategy Bullseye
 * provider selection, review, and merge gates, same as any other ticket. That is the whole
 * design: the board is what runs agents, and a plugin skill is not a second way to do it.
 */

export interface PluginSkillRunResult {
  issueId: string;
  issueNumber: number | null;
  workspaceId: string;
  branch: string;
}

/**
 * Stages of a skill launch, in order. The ticket lands in milliseconds and the workspace behind
 * it takes minutes (worktree → the project's setup script → agent launch), so a launcher that
 * only sees the final result stares at a spinner with no evidence anything happened — while the
 * ticket has in fact been on the board the whole time.
 */
export type PluginSkillRunProgress =
  | { stage: "ticket"; issueId: string; issueNumber: number | null; title: string }
  | { stage: "workspace"; issueId: string; issueNumber: number | null; setupScript: string | null }
  | ({ stage: "done" } & PluginSkillRunResult);

export interface RunSkillOptions {
  title?: string;
  description?: string;
  prompt?: string;
  /** Explicit workflow template for the ticket; overrides the manifest's declared default. */
  workflowTemplateId?: string | null;
  onProgress?: (event: PluginSkillRunProgress) => void;
}

export async function runPluginSkill(
  args: { pluginRowId: string; skillName: string; projectId: string; opts?: RunSkillOptions },
  deps: {
    database: Database;
    requirePlugin: (id: string) => Promise<PluginRow & { manifest: PluginManifest }>;
    requireProject: (projectId: string) => Promise<{
      id: string; name: string; repoPath: string;
      setupScript?: string | null; setupEnabled?: boolean | null;
    }>;
    createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
    createWorkspace?: (input: CreateWorkspaceInput) => Promise<CreateWorkspaceResult>;
  },
): Promise<PluginSkillRunResult> {
  const { skillName, projectId, opts } = args;
  const { createIssue, createWorkspace } = deps;
  if (!createIssue || !createWorkspace) {
    throw new PluginError("Skill execution is not available on this route", "BAD_REQUEST");
  }
  const plugin = await deps.requirePlugin(args.pluginRowId);
  const project = await deps.requireProject(projectId);
  const skillDef = (plugin.manifest.skills ?? []).find((s) => pluginSkillName(s.dir) === skillName);
  if (!skillDef) throw new PluginError(`Skill "${skillName}" not found in plugin manifest`, "NOT_FOUND");

  // Workflow precedence: what the launcher picked → what the plugin declares for this skill →
  // the board's per-issue-type default. The launcher's choice always wins; the manifest only
  // supplies a better starting point than "whatever the board does for a generic task".
  const workflowTemplateId = opts?.workflowTemplateId
    ?? await resolveWorkflowTemplateId(projectId, skillDef.workflow, deps.database);

  const title = opts?.title?.trim() || `${plugin.name}: run ${skillName}`;
  const base = opts?.description?.trim()
    || `Run the \`${skillName}\` skill from the "${plugin.name}" plugin against this project.`;
  // `prompt` is what the launcher typed: extra context for THIS run ("only the billing
  // module", "focus on the error paths"). It is APPENDED rather than substituted, because a
  // description that replaced the base would drop the one sentence naming the skill to run.
  const extra = opts?.prompt?.trim();
  const description = extra ? `${base}\n\n## Additional context for this run\n\n${extra}` : base;

  const issue = await createIssue({
    projectId,
    title,
    description,
    issueType: "task",
    priority: "medium",
    skipAutoReview: true,
    workflowTemplateId,
  });
  // The ticket exists within milliseconds; provisioning the workspace behind it takes MINUTES
  // (worktree, then the project's setup script, then the agent launch). Reporting the ticket
  // now is the difference between "nothing happened" and "it is running" — see the route's
  // streaming mode, which forwards these to the launcher.
  opts?.onProgress?.({ stage: "ticket", issueId: issue.id, issueNumber: issue.issueNumber, title });
  opts?.onProgress?.({
    stage: "workspace",
    issueId: issue.id,
    issueNumber: issue.issueNumber,
    setupScript: project.setupEnabled === false ? null : project.setupScript ?? null,
  });

  const workspace = await createWorkspace({ issueId: issue.id, skillName });
  const result = {
    issueId: issue.id,
    issueNumber: issue.issueNumber,
    workspaceId: workspace.id,
    branch: workspace.branch,
  };
  opts?.onProgress?.({ stage: "done", ...result });
  return result;
}

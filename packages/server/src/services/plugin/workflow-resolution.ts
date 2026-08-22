import { listWorkflowTemplates, type WorkflowDb } from "@agentic-kanban/shared/lib/workflow-engine";
import type { Database } from "../../db/index.js";

/**
 * Resolve a manifest's `workflow` string to a template id for this project.
 *
 * Accepts a builtin key (`research-task`), a template name ("Research Task"), or an id, in
 * that order — a plugin ships one manifest for every board, so it cannot know local template
 * ids, and builtin keys are the only stable handle across installs. An unresolvable value is
 * NOT an error: the board's own default takes over and a warning is logged, because a plugin
 * naming a workflow this board has never heard of should degrade, not block the launch.
 */
export async function resolveWorkflowTemplateId(
  projectId: string,
  workflow: string | undefined,
  database: Database,
): Promise<string | null> {
  const wanted = workflow?.trim();
  if (!wanted) return null;
  const templates = await listWorkflowTemplates(database as unknown as WorkflowDb, projectId);
  const needle = wanted.toLowerCase();
  const match = templates.find((t) => t.builtinKey?.toLowerCase() === needle)
    ?? templates.find((t) => t.name.toLowerCase() === needle)
    ?? templates.find((t) => t.id === wanted);
  if (!match) {
    console.warn(`[plugins] workflow "${wanted}" not found for project ${projectId} — using the board default`);
    return null;
  }
  return match.id;
}

import { existsSync, readFileSync } from "node:fs";
import {
  buildPluginPlaceholderVars,
  pluginSkillName,
  substitutePluginPlaceholders,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../../db/index.js";
import { listEnabledPlugins } from "../plugin-enabled.js";
import { resolveInside } from "../plugin-fs.js";

/**
 * What the project's BUTLER is told about the enabled plugins.
 *
 * Two halves, and the split is the point:
 * - the plugin AUTHOR's own `butler.promptFragment`, substituted — it explains how to consume the
 *   plugin's output, and it drifts, because prose does;
 * - a DERIVED capability roster (skills + loops, straight off the manifest) — it cannot drift, and
 *   it is what a plugin shipping no fragment at all contributes instead of being invisible.
 *
 * A broken plugin must never take the butler down: every plugin is assembled inside its own
 * try/catch and a failure costs that plugin's section, nothing more.
 */

export async function buildButlerFragments(
  projectId: string,
  deps: {
    database: Database;
    boardUrl: string;
    requireProject: (projectId: string) => Promise<{ id: string; repoPath: string; name: string }>;
    /** Resolves the output repo WITHOUT creating it — see the call site's comment. */
    peekOutputRepoPath: (pluginSlug: string, project: { id: string; repoPath: string }) => Promise<string>;
  },
): Promise<string[]> {
  const enabledPlugins = await listEnabledPlugins(projectId, deps.database);
  if (enabledPlugins.length === 0) return [];
  let project: { id: string; repoPath: string; name: string } | null = null;
  try {
    project = await deps.requireProject(projectId);
  } catch {
    return [];
  }
  const fragments: string[] = [];
  for (const { row, manifest } of enabledPlugins) {
    try {
      // `{{repoPath}}` is the OUTPUT repo at every other substitution site; this one used to
      // hand the butler the LEADING repo for both placeholders, so in sidecar mode a fragment
      // saying "the register lives in {{repoPath}}/docs" named a path with nothing in it.
      // Resolved WITHOUT creating anything — assembling a prompt must not materialize a repo —
      // so a sidecar that has not been created yet still falls back to the leading repo.
      const vars = buildPluginPlaceholderVars({
        outputRepoPath: await deps.peekOutputRepoPath(row.pluginId, project),
        leadingRepoPath: project.repoPath,
        projectName: project.name,
        pluginPath: row.localPath,
        boardUrl: deps.boardUrl,
        projectId,
      });

      const parts: string[] = [];
      if (manifest.butler?.promptFragment) {
        const fragmentPath = resolveInside(row.localPath, manifest.butler.promptFragment, "butler.promptFragment");
        if (existsSync(fragmentPath)) {
          const text = substitutePluginPlaceholders(readFileSync(fragmentPath, "utf8"), vars).trim();
          if (text) parts.push(text);
        }
      }

      const roster = pluginCapabilityRoster(manifest);
      if (roster) parts.push(roster);

      if (parts.length) fragments.push(`## Plugin: ${row.name}\n\n${parts.join("\n\n")}`);
    } catch {
      /* a broken plugin must never take the butler down */
    }
  }
  return fragments;
}

/**
 * What an enabled plugin can be ASKED to do, DERIVED from its manifest so it cannot drift out of
 * date the way hand-written prose does. A plugin's own fragment is written by its author: it
 * explains how to consume the output and rarely lists what the plugin can be asked to do. Skill
 * names are the directory basenames — the same identifiers `loops[].skill` uses and the same ones
 * materialized into each ticket's worktree.
 *
 * Returns "" when the plugin declares neither skills nor loops, so a plugin with nothing to offer
 * adds nothing to the butler's context.
 */
export function pluginCapabilityRoster(manifest: PluginManifest): string {
  const lines: string[] = [];
  const skills = manifest.skills ?? [];
  if (skills.length) {
    lines.push("**Skills it provides** (run one to create a ticket and launch a workspace against it):");
    for (const s of skills) {
      const name = pluginSkillName(s.dir);
      lines.push(s.description ? `- \`${name}\` — ${s.description}` : `- \`${name}\``);
    }
  }
  const loops = manifest.loops ?? [];
  if (loops.length) {
    if (lines.length) lines.push("");
    lines.push("**Converging loops** (each advance tickets the units its plan says are ready):");
    for (const l of loops) {
      const via = l.skill ? ` — hands out \`${l.skill}\`` : "";
      lines.push(`- \`${l.name}\`${l.label && l.label !== l.name ? ` (${l.label})` : ""}${via}`);
    }
  }
  return lines.join("\n");
}

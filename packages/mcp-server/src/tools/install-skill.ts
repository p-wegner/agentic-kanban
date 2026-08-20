import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { writeAgentSkillFile, ensureCodexSkillsLink, skillsDirOf } from "@agentic-kanban/shared/lib/agent-skill-files";
import { listBundledSkills, installBundledSkill } from "@agentic-kanban/shared/lib/bundled-skills";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpError, mcpText } from "../db-utils.js";

export function registerInstallSkill(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "install_skill",
    "Install agent skills into a project's .claude/skills/ directory and link .codex/skills to the same location. Mirrors CLI `install-skill [target-path]`. Two kinds are installed: BUNDLED skills, which ship with the package as a directory (SKILL.md + references/) and are junctioned so they track package upgrades, and prompt-only built-ins read from the DB (requires db:seed to have run), written as <targetPath>/.claude/skills/<name>/SKILL.md.",
    {
      targetPath: z.string().describe("Absolute path to the target project directory. Skills will be written to <targetPath>/.claude/skills/"),
      names: z.array(z.string()).optional().describe("List of specific built-in skill names to install. If omitted, all built-in global skills are installed."),
      listOnly: z.boolean().optional().describe("If true, return the list of available built-in skills without installing anything"),
    },
    async ({ targetPath, names, listOnly }) => {
      // Fetch all global built-in skills from the DB (seeded by db:seed / pnpm db:seed)
      const allBuiltins = await db
        .select()
        .from(schema.agentSkills)
        .where(eq(schema.agentSkills.isBuiltin, true))
        .orderBy(schema.agentSkills.name);

      // Only global skills (no projectId) — matches CLI behaviour
      const dbBuiltins = allBuiltins.filter(s => s.projectId === null);

      // A bundled directory WINS over a same-named DB row: it is the richer form of the same
      // skill (it carries references/), and installing both would leave the loser's SKILL.md.
      const bundled = await listBundledSkills();
      const bundledNames = new Set(bundled.map(s => s.name));
      const globalBuiltins = dbBuiltins.filter(s => !bundledNames.has(s.name));

      if (listOnly) {
        return mcpText(JSON.stringify(
                {
                  bundledSkills: bundled.map(s => ({ name: s.name, description: s.description, commit: s.commit })),
                  availableSkills: globalBuiltins.map(s => ({ name: s.name, description: s.description })),
                },
                null,
                2,
              ));
      }

      const resolvedPath = resolvePath(targetPath);
      try {
        await access(resolvedPath);
      } catch {
        return mcpError(`Error: Target path does not exist: ${resolvedPath}`);
      }

      const installed: string[] = [];
      const errors: { name: string; error: string }[] = [];

      let skills = [...globalBuiltins];
      let bundledToInstall = [...bundled];
      if (names && names.length > 0) {
        const nameSet = new Set(names);
        skills = skills.filter(s => nameSet.has(s.name));
        bundledToInstall = bundledToInstall.filter(s => nameSet.has(s.name));
        if (skills.length === 0 && bundledToInstall.length === 0) {
          const all = [...bundled.map(s => s.name), ...globalBuiltins.map(s => s.name)].sort();
          return mcpText(`No matching skills found. Available: ${all.join(", ")}`);
        }
      }

      // Bundled skills do not go through writeAgentSkillFile, so link .codex here — otherwise a
      // bundled-only install leaves Codex pointing at nothing.
      const skillsDir = skillsDirOf(resolvedPath);
      if (bundledToInstall.length > 0) await ensureCodexSkillsLink(resolvedPath);
      const linked: { name: string; mode: string }[] = [];
      for (const skill of bundledToInstall) {
        try {
          const result = await installBundledSkill(skill, skillsDir);
          linked.push({ name: skill.name, mode: result.mode });
        } catch (err) {
          errors.push({ name: skill.name, error: errorMessage(err) });
        }
      }

      for (const skill of skills) {
        if (/[/\\]|\.\./.test(skill.name)) {
          errors.push({ name: skill.name, error: "Unsafe skill name — skipped" });
          continue;
        }
        try {
          await writeAgentSkillFile(resolvedPath, {
            name: skill.name,
            description: skill.description,
            prompt: skill.prompt,
          });
          installed.push(skill.name);
        } catch (err) {
          errors.push({ name: skill.name, error: errorMessage(err) });
        }
      }

      return mcpText(JSON.stringify(
              {
                targetPath: resolvedPath,
                installed,
                bundled: linked,
                errors: errors.length > 0 ? errors : undefined,
                skillsDir: `${resolvedPath}/.claude/skills/`,
              },
              null,
              2,
            ));
    },
  );
}

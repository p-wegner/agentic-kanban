import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { db, schema } from "../db.js";
import { writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";

export function registerInstallSkill(server: McpServer) {
  server.tool(
    "install_skill",
    "Install built-in agent skills as SKILL.md files into a project's .claude/skills/ directory and link .codex/skills to the same location. Mirrors CLI `install-skill [target-path]`. Reads built-in global skills from the DB (requires db:seed to have run). Each skill is written as <targetPath>/.claude/skills/<name>/SKILL.md.",
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
      const globalBuiltins = allBuiltins.filter(s => s.projectId === null);

      if (listOnly) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { availableSkills: globalBuiltins.map(s => ({ name: s.name, description: s.description })) },
                null,
                2,
              ),
            },
          ],
        };
      }

      const resolvedPath = resolvePath(targetPath);
      try {
        await access(resolvedPath);
      } catch {
        return {
          content: [{ type: "text" as const, text: `Error: Target path does not exist: ${resolvedPath}` }],
        };
      }

      let skills = [...globalBuiltins];
      if (names && names.length > 0) {
        const nameSet = new Set(names);
        skills = skills.filter(s => nameSet.has(s.name));
        if (skills.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No matching skills found. Available: ${globalBuiltins.map(s => s.name).join(", ")}`,
              },
            ],
          };
        }
      }

      const installed: string[] = [];
      const errors: { name: string; error: string }[] = [];

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
          errors.push({ name: skill.name, error: err instanceof Error ? err.message : String(err) });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                targetPath: resolvedPath,
                installed,
                errors: errors.length > 0 ? errors : undefined,
                skillsDir: `${resolvedPath}/.claude/skills/`,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { sql } from "drizzle-orm";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { ensureCodexSkillsLink, writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";

export function registerExportAgentSkills(server: McpServer) {
  server.tool(
    "export_agent_skills",
    "Export agent skills as SKILL.md files for Claude Code and Codex. Writes .claude/skills and links .codex/skills to the same directory.",
    {
      targetPath: z.string().describe("Absolute path to the project directory where .claude/skills/ will be written and .codex/skills will be linked"),
      projectId: z.string().optional().describe("Optional project ID to export only project-specific + global skills"),
      skillNames: z.array(z.string()).optional().describe("Optional list of specific skill names to export. If omitted, exports all accessible skills."),
    },
    async ({ targetPath, projectId, skillNames }) => {
      try {
        // Verify target path exists
        try {
          await access(targetPath);
        } catch {
          return { content: [{ type: "text" as const, text: `Error: Target path does not exist: ${targetPath}` }] };
        }

        // Fetch skills
        let rows;
        if (projectId) {
          rows = await db.select().from(schema.agentSkills)
            .where(sql`${schema.agentSkills.projectId} IS NULL OR ${schema.agentSkills.projectId} = ${projectId}`)
            .orderBy(schema.agentSkills.name);
        } else {
          rows = await db.select().from(schema.agentSkills).orderBy(schema.agentSkills.name);
        }

        // Filter by skill names if provided
        if (skillNames && skillNames.length > 0) {
          rows = rows.filter(s => skillNames.includes(s.name));
        }

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "No skills found to export." }] };
        }

        const skillsDir = join(targetPath, ".claude", "skills");
        await ensureCodexSkillsLink(targetPath);

        // Track existing skill directories we manage (to clean up stale ones)
        const exportedNames = new Set<string>();

        for (const skill of rows) {
          if (/[\/\\]|\.\./.test(skill.name)) {
            console.warn(`[export] skipping skill with unsafe name: ${skill.name}`);
            continue;
          }
          await writeAgentSkillFile(targetPath, skill);
          exportedNames.add(skill.name);
        }

        const scopeDesc = projectId ? `project + global` : "all";
        return {
          content: [{
            type: "text" as const,
            text: `Exported ${rows.length} skill(s) to ${skillsDir} and linked .codex/skills to the same directory:\n${rows.map(s => `  - ${s.name} (${s.isBuiltin ? "builtin" : "custom"}${s.projectId ? ", project-scoped" : ", global"})`).join("\n")}\n\nThese skills are now available in Claude Code and Codex when working in ${targetPath}.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error exporting skills: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );
}

import type { Command } from "commander";
import { runMigrations } from "../shared.js";
import {
  listAgentSkills,
  getAgentSkillById,
  getAgentSkillByName,
  findSkillByName,
  createAgentSkill,
} from "../../repositories/agent-skill.repository.js";

export function registerSkillCommand(program: Command) {
  const skillCmd = program.command("skill").description("Manage agent skills.\n\nSkills are prompt templates that can be injected into agent context when creating workspaces. Built-in skills (board-navigator, code-review, dependency-analyzer, ticket-enhancer) are seeded on first run and cannot be modified.\n\nSkills can be global (available to all projects) or project-scoped.\n\nSubcommands: list, get, create, export");

  skillCmd
    .command("list")
    .description("List agent skills.\n\nShows skill name, scope (global/project), model override, and description. Built-in skills are marked with [builtin].")
    .option("-p, --project <projectId>", "Filter to project-specific + global skills")
    .addHelpText("after", `
Examples:
  $ agentic-kanban skill list                         # all skills
  $ agentic-kanban skill list -p 180b7363-...         # project + global skills
`)
    .action(async (options: { project?: string }) => {
      try {
        await runMigrations();
        const rows = await listAgentSkills(options.project, false);
        if (rows.length === 0) {
          console.log("No agent skills found.");
          process.exit(0);
        }
        for (const s of rows) {
          const builtin = s.isBuiltin ? " [builtin]" : "";
          const model = s.model ? ` (model: ${s.model})` : "";
          const scope = s.projectId ? ` (project)` : " (global)";
          console.log(`  ${s.name}${builtin}${model}${scope}`);
          console.log(`    id: ${s.id}`);
          console.log(`    ${s.description}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  skillCmd
    .command("get <name-or-id>")
    .description("Show full details of a skill including its prompt template.\n\nDisplays the skill name, ID, description, model override, scope, and the full prompt text. Useful for reviewing or debugging skill prompts.")
    .addHelpText("after", `
Examples:
  $ agentic-kanban skill get code-review
  $ agentic-kanban skill get abc123-def456-...
`)
    .action(async (nameOrId: string) => {
      try {
        await runMigrations();
        const s = (await getAgentSkillByName(nameOrId)) ?? (await getAgentSkillById(nameOrId));
        if (!s) {
          console.error(`Skill '${nameOrId}' not found.`);
          process.exit(1);
        }
        console.log(`Name: ${s.name}`);
        console.log(`ID: ${s.id}`);
        console.log(`Description: ${s.description}`);
        console.log(`Model: ${s.model ?? "default"}`);
        console.log(`Scope: ${s.projectId ? `project (${s.projectId})` : "global"}`);
        console.log(`Builtin: ${s.isBuiltin}`);
        console.log(`\n--- Prompt ---\n${s.prompt}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  skillCmd
    .command("create <name>")
    .description("Create a new agent skill.\n\nCreates a custom prompt template that can be selected when creating a workspace. Skill names must be unique within their scope (global or same project). Names cannot contain '/', '\\', or '..'.")
    .option("-d, --description <description>", "Skill description (defaults to name)")
    .option("-p, --prompt <prompt>", "Skill prompt template text (defaults to 'No prompt provided.')")
    .option("-m, --model <model>", "Model override: haiku, sonnet, opus (default: no override)")
    .option("--project <projectId>", "Scope skill to a specific project (omit for global)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban skill create my-reviewer -d "Custom code reviewer" -p "Review for..."
  $ agentic-kanban skill create quick-fix -m haiku -p "Apply quick fixes"
  $ agentic-kanban skill create project-skill --project 180b7363-... -p "Project-specific prompt"
`)
    .action(async (name: string, options: { description?: string; prompt?: string; model?: string; project?: string }) => {
      try {
        await runMigrations();
        if (/[/\\]|\.\./.test(name)) {
          console.error("Skill name cannot contain '/', '\\', or '..'.");
          process.exit(1);
        }
        const scopeProjectId = options.project || null;
        const existing = await findSkillByName(name, scopeProjectId);
        if (existing) {
          console.error(`Skill '${name}' already exists in this scope.`);
          process.exit(1);
        }
        const created = await createAgentSkill({
          name,
          description: options.description ?? name,
          prompt: options.prompt ?? "No prompt provided.",
          model: options.model ?? null,
          projectId: scopeProjectId,
        });
        const scope = scopeProjectId ? ` (project: ${scopeProjectId})` : " (global)";
        console.log(`Created skill '${name}'${scope}`);
        console.log(`  id: ${created.id}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  skillCmd
    .command("export <target-path>")
    .description("Export skills as SKILL.md files for Claude Code and Codex.\n\nWrites skills into the .claude/skills/ directory of the target project and links .codex/skills to the same directory. Each skill is written as <name>/SKILL.md with frontmatter.")
    .option("-p, --project <projectId>", "Export only project-specific + global skills")
    .option("-n, --names <names>", "Comma-separated list of skill names to export")
    .addHelpText("after", `
Examples:
  $ agentic-kanban skill export /path/to/my-project
  $ agentic-kanban skill export . -n "code-review,dependency-analyzer"
  $ agentic-kanban skill export . -p 180b7363-...
`)
    .action(async (targetPath: string, options: { project?: string; names?: string }) => {
      try {
        await runMigrations();
        const { access } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { ensureCodexSkillsLink, writeAgentSkillFile } = await import("@agentic-kanban/shared/lib/agent-skill-files");

        try {
          await access(targetPath);
        } catch {
          console.error(`Target path does not exist: ${targetPath}`);
          process.exit(1);
        }

        let rows = await listAgentSkills(options.project, false);

        if (options.names) {
          const nameSet = new Set(options.names.split(",").map(n => n.trim()));
          rows = rows.filter(s => nameSet.has(s.name));
        }

        if (rows.length === 0) {
          console.log("No skills found to export.");
          process.exit(0);
        }

        const skillsDir = join(targetPath, ".claude", "skills");
        await ensureCodexSkillsLink(targetPath);

        for (const skill of rows) {
          if (/[/\\]|\.\./.test(skill.name)) {
            console.warn(`  Skipping skill with unsafe name: ${skill.name}`);
            continue;
          }
          await writeAgentSkillFile(targetPath, skill);
        }

        console.log(`Exported ${rows.length} skill(s) to ${skillsDir} and linked .codex/skills to the same directory:`);
        for (const s of rows) {
          const scope = s.projectId ? "project" : "global";
          const builtin = s.isBuiltin ? " [builtin]" : "";
          console.log(`  - ${s.name} (${scope}${builtin})`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

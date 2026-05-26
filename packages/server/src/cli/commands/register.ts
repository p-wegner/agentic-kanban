import type { Command } from "commander";
import { db } from "../../db/index.js";
import { projects, projectStatuses, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { detectRepoInfo } from "../../services/git-info.service.js";
import { runMigrations, DEFAULT_STATUSES, logDefaultBranch } from "../shared.js";

export function registerRegisterCommand(program: Command) {
  program
    .command("register")
    .description("Register a git repo as a project.\n\nAuto-detects repo name, default branch, and remote URL from the git repo at <path>. Creates 6 default statuses (Todo, In Progress, In Review, AI Reviewed, Done, Cancelled) and sets the project as the active project.\n\nIf the repo is already registered (same path), it skips without error.")
    .argument("<path>", "Path to the git repository")
    .option("-n, --name <name>", "Custom project name (defaults to repo directory name)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban register .                 # register current directory
  $ agentic-kanban register /path/to/my-repo  # register a specific repo
  $ agentic-kanban register . --name "My App" # custom project name
`)
    .action(async (path: string, options: { name?: string }) => {
      try {
        await runMigrations();

        const repoInfo = await detectRepoInfo(path);
        const projectName = options.name || repoInfo.repoName;

        const existing = await db
          .select()
          .from(projects)
          .where(eq(projects.repoPath, repoInfo.repoPath))
          .limit(1);

        if (existing.length > 0) {
          console.log(`Project "${existing[0].name}" already registered at ${repoInfo.repoPath}`);
          process.exit(0);
        }

        const now = new Date().toISOString();
        const projectId = randomUUID();

        await db.insert(projects).values({
          id: projectId,
          name: projectName,
          repoPath: repoInfo.repoPath,
          repoName: repoInfo.repoName,
          defaultBranch: repoInfo.defaultBranch,
          remoteUrl: repoInfo.remoteUrl,
          createdAt: now,
          updatedAt: now,
        });

        for (const status of DEFAULT_STATUSES) {
          await db.insert(projectStatuses).values({
            id: randomUUID(),
            projectId,
            name: status.name,
            sortOrder: status.sortOrder,
            isDefault: status.isDefault,
            createdAt: now,
          });
        }

        await db
          .insert(preferences)
          .values({
            key: "activeProjectId",
            value: projectId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: preferences.key,
            set: { value: projectId, updatedAt: now },
          });

        console.log(`Registered project "${projectName}"`);
        console.log(`  Repo: ${repoInfo.repoPath}`);
        logDefaultBranch(repoInfo.defaultBranch);
        if (repoInfo.remoteUrl) {
          console.log(`  Remote: ${repoInfo.remoteUrl}`);
        }
        console.log(`  Statuses: ${DEFAULT_STATUSES.map((s) => s.name).join(", ")}`);
        console.log(`  Set as active project.`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

#!/usr/bin/env node
import { Command } from "commander";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./db/index.js";
import { projects, projectStatuses, preferences, workspaces, issues, issueTags, sessions } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { detectRepoInfo } from "./services/git-info.service.js";

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "Done", sortOrder: 3, isDefault: false },
  { name: "Cancelled", sortOrder: 4, isDefault: false },
];

async function runMigrations() {
  await migrate(db, { migrationsFolder: "../shared/drizzle" });
}

const program = new Command();

program
  .name("agentic-kanban")
  .description("CLI for managing agentic-kanban projects")
  .version("0.0.1");

program
  .command("register")
  .description("Register a git repo as a project")
  .argument("<path>", "Path to the git repository")
  .option("-n, --name <name>", "Custom project name (defaults to repo directory name)")
  .action(async (path: string, options: { name?: string }) => {
    try {
      await runMigrations();

      const repoInfo = await detectRepoInfo(path);
      const projectName = options.name || repoInfo.repoName;

      // Check if a project with this repo path already exists
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

      // Set as active project
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
      console.log(`  Branch: ${repoInfo.defaultBranch}`);
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

program
  .command("unregister")
  .description("Remove a registered project by name or ID")
  .argument("<name-or-id>", "Project name or ID")
  .action(async (nameOrId: string) => {
    try {
      await runMigrations();

      // Try to find by name first, then by ID
      let rows = await db
        .select()
        .from(projects)
        .where(eq(projects.name, nameOrId))
        .limit(1);

      if (rows.length === 0) {
        rows = await db
          .select()
          .from(projects)
          .where(eq(projects.id, nameOrId))
          .limit(1);
      }

      if (rows.length === 0) {
        console.error(`Project "${nameOrId}" not found.`);
        process.exit(1);
      }

      const project = rows[0];
      const projectId = project.id;

      // Cascade delete: find all issues for this project
      const projectIssues = await db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.projectId, projectId));

      if (projectIssues.length > 0) {
        const issueIds = projectIssues.map((i) => i.id);

        // Delete issue tags
        await db.delete(issueTags).where(inArray(issueTags.issueId, issueIds));

        // Find and cleanup workspaces for these issues
        const wsRows = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(inArray(workspaces.issueId, issueIds));

        if (wsRows.length > 0) {
          const wsIds = wsRows.map((w) => w.id);
          // Delete sessions for these workspaces
          await db.delete(sessions).where(inArray(sessions.workspaceId, wsIds));
          // Delete workspaces
          await db.delete(workspaces).where(inArray(workspaces.id, wsIds));
        }

        // Delete issues
        await db.delete(issues).where(inArray(issues.id, issueIds));
      }

      // Delete project statuses
      await db.delete(projectStatuses).where(eq(projectStatuses.projectId, projectId));

      // Delete project
      await db.delete(projects).where(eq(projects.id, projectId));

      console.log(`Unregistered project "${project.name}" (${project.id})`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List registered projects")
  .action(async () => {
    try {
      await runMigrations();

      const allProjects = await db.select().from(projects);

      if (allProjects.length === 0) {
        console.log("No projects registered.");
        console.log('Run `pnpm cli -- register <path>` to register a git repo.');
        process.exit(0);
      }

      // Get active project
      const activePref = await db
        .select()
        .from(preferences)
        .where(eq(preferences.key, "activeProjectId"))
        .limit(1);
      const activeId = activePref.length > 0 ? activePref[0].value : null;

      for (const p of allProjects) {
        const marker = p.id === activeId ? " (active)" : "";
        console.log(`  ${p.name}${marker}`);
        console.log(`    Path: ${p.repoPath}`);
        console.log(`    Branch: ${p.defaultBranch}`);
        if (p.remoteUrl) {
          console.log(`    Remote: ${p.remoteUrl}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("cleanup")
  .description("Remove stale worktrees for closed workspaces")
  .action(async () => {
    try {
      await runMigrations();

      const closedWorkspaces = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.status, "closed"));

      const withWorktrees = closedWorkspaces.filter((ws) => ws.workingDir);

      if (withWorktrees.length === 0) {
        console.log("No stale worktrees found.");
        process.exit(0);
      }

      console.log(`Found ${withWorktrees.length} closed workspace(s) with worktrees:`);
      for (const ws of withWorktrees) {
        console.log(`  ${ws.branch} → ${ws.workingDir}`);
      }
      console.log("\nThese worktrees can be removed manually with:");
      console.log("  git worktree remove --force <path>");
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program.parse();

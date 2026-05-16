#!/usr/bin/env node
import { Command } from "commander";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./db/index.js";
import { projects, projectStatuses, preferences, workspaces, issues, issueTags, sessions, issueDependencies, DEPENDENCY_TYPES } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { detectRepoInfo } from "./services/git-info.service.js";

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
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

async function getActiveProjectId(): Promise<string> {
  const pref = await db.select().from(preferences).where(eq(preferences.key, "activeProjectId")).limit(1);
  if (pref.length === 0) throw new Error("No active project. Run `pnpm cli -- register <path>` first.");
  return pref[0].value;
}

// ── issue commands ────────────────────────────────────────────────────────────

const issueCmd = program.command("issue").description("Manage issues");

issueCmd
  .command("list")
  .description("List issues for the active project")
  .option("-s, --status <status>", "Filter by status name (e.g. Todo, 'In Progress')")
  .option("-p, --priority <priority>", "Filter by priority (low, medium, high, critical)")
  .action(async (options: { status?: string; priority?: string }) => {
    try {
      await runMigrations();
      const projectId = await getActiveProjectId();

      let rows = await db
        .select({
          issueNumber: issues.issueNumber,
          id: issues.id,
          title: issues.title,
          priority: issues.priority,
          statusName: projectStatuses.name,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .where(eq(issues.projectId, projectId));

      if (options.status) rows = rows.filter((r) => r.statusName === options.status);
      if (options.priority) rows = rows.filter((r) => r.priority === options.priority);

      if (rows.length === 0) {
        console.log("No issues found.");
        process.exit(0);
      }

      for (const r of rows) {
        const num = r.issueNumber != null ? `#${r.issueNumber}` : "(no number)";
        console.log(`  ${num.padEnd(6)} [${r.priority.padEnd(8)}] [${r.statusName}] ${r.title}`);
        console.log(`         id: ${r.id}`);
      }
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

issueCmd
  .command("create <title>")
  .description("Create a new issue in the active project")
  .option("-d, --description <description>", "Issue description")
  .option("-p, --priority <priority>", "Priority: low, medium, high, critical (default: medium)")
  .option("-s, --status <status>", "Initial status name (default: Todo)")
  .action(async (title: string, options: { description?: string; priority?: string; status?: string }) => {
    try {
      await runMigrations();
      const projectId = await getActiveProjectId();

      const statuses = await db
        .select()
        .from(projectStatuses)
        .where(eq(projectStatuses.projectId, projectId))
        .orderBy(projectStatuses.sortOrder);

      if (statuses.length === 0) throw new Error("No statuses found for project.");

      let statusId = statuses[0].id;
      if (options.status) {
        const found = statuses.find((s) => s.name === options.status);
        if (!found) {
          console.error(`Status '${options.status}' not found. Available: ${statuses.map((s) => s.name).join(", ")}`);
          process.exit(1);
        }
        statusId = found.id;
      }

      const maxResult = await db
        .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
        .from(issues)
        .where(eq(issues.projectId, projectId));
      const issueNumber = (maxResult[0]?.maxNum ?? 0) + 1;

      const id = randomUUID();
      const now = new Date().toISOString();

      await db.insert(issues).values({
        id,
        issueNumber,
        title,
        description: options.description ?? null,
        priority: (options.priority as "low" | "medium" | "high" | "critical") ?? "medium",
        sortOrder: 0,
        statusId,
        projectId,
        createdAt: now,
        updatedAt: now,
      });

      console.log(`Created issue #${issueNumber}: ${title}`);
      console.log(`  id: ${id}`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

issueCmd
  .command("move <issue-id> <status>")
  .description("Move an issue to a different status")
  .action(async (issueId: string, statusName: string) => {
    try {
      await runMigrations();

      const issueRows = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
      if (issueRows.length === 0) {
        console.error(`Issue '${issueId}' not found.`);
        process.exit(1);
      }

      const statuses = await db
        .select()
        .from(projectStatuses)
        .where(eq(projectStatuses.projectId, issueRows[0].projectId));
      const target = statuses.find((s) => s.name === statusName);
      if (!target) {
        console.error(`Status '${statusName}' not found. Available: ${statuses.map((s) => s.name).join(", ")}`);
        process.exit(1);
      }

      await db.update(issues).set({ statusId: target.id, updatedAt: new Date().toISOString() }).where(eq(issues.id, issueId));

      console.log(`Moved issue to '${statusName}'`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── workspace commands ────────────────────────────────────────────────────────

const wsCmd = program.command("workspace").description("Manage workspaces");

wsCmd
  .command("list")
  .description("List workspaces for the active project")
  .option("-s, --status <status>", "Filter by status: active, idle, closed")
  .action(async (options: { status?: string }) => {
    try {
      await runMigrations();
      const projectId = await getActiveProjectId();

      const projectIssues = await db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.projectId, projectId));

      if (projectIssues.length === 0) {
        console.log("No workspaces found (no issues in active project).");
        process.exit(0);
      }

      const issueIds = projectIssues.map((i) => i.id);
      let rows = await db.select().from(workspaces).where(inArray(workspaces.issueId, issueIds));

      if (options.status) rows = rows.filter((r) => r.status === options.status);

      if (rows.length === 0) {
        console.log("No workspaces found.");
        process.exit(0);
      }

      for (const ws of rows) {
        console.log(`  [${ws.status.padEnd(6)}] ${ws.branch}`);
        console.log(`         id: ${ws.id}`);
        if (ws.workingDir) console.log(`         dir: ${ws.workingDir}`);
      }
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

wsCmd
  .command("create <issue-id>")
  .description("Create a git worktree workspace for an issue")
  .option("-b, --branch <branch>", "Branch name (default: workspace/<issue-id-short>)")
  .option("--base <baseBranch>", "Base branch to create from (default: project default branch)")
  .action(async (issueId: string, options: { branch?: string; base?: string }) => {
    try {
      await runMigrations();

      const issueRows = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
      if (issueRows.length === 0) {
        console.error(`Issue '${issueId}' not found.`);
        process.exit(1);
      }

      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.id, issueRows[0].projectId))
        .limit(1);
      if (projectRows.length === 0 || !projectRows[0].repoPath) {
        console.error("Project has no repo path configured.");
        process.exit(1);
      }

      const project = projectRows[0];
      const { createWorktree } = await import("./services/git.service.js");

      const branchName = options.branch ?? `workspace/${issueId.slice(0, 8)}`;
      const baseBranch = options.base ?? project.defaultBranch;
      const worktreePath = await createWorktree(project.repoPath, branchName, baseBranch);

      const id = randomUUID();
      const now = new Date().toISOString();

      await db.insert(workspaces).values({
        id,
        issueId,
        branch: branchName,
        workingDir: worktreePath,
        baseBranch,
        isDirect: false,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      console.log(`Created workspace for issue '${issueId}'`);
      console.log(`  id: ${id}`);
      console.log(`  branch: ${branchName}`);
      console.log(`  dir: ${worktreePath}`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── dependency commands ─────────────────────────────────────────────────────────

const depCmd = issueCmd.command("dependency").description("Manage issue dependencies");

depCmd
  .command("list <issue-id>")
  .description("List dependencies for an issue")
  .action(async (issueId: string) => {
    try {
      await runMigrations();

      // Outgoing: this issue depends on / relates to others
      const outgoing = await db
        .select({
          id: issueDependencies.id,
          type: issueDependencies.type,
          targetTitle: issues.title,
          targetNumber: issues.issueNumber,
          targetStatusName: projectStatuses.name,
        })
        .from(issueDependencies)
        .innerJoin(issues, eq(issueDependencies.dependsOnId, issues.id))
        .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .where(eq(issueDependencies.issueId, issueId));

      // Incoming: others depend on / relate to this issue
      const incoming = await db
        .select({
          id: issueDependencies.id,
          type: issueDependencies.type,
          sourceTitle: issues.title,
          sourceNumber: issues.issueNumber,
          sourceStatusName: projectStatuses.name,
        })
        .from(issueDependencies)
        .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
        .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .where(eq(issueDependencies.dependsOnId, issueId));

      if (outgoing.length === 0 && incoming.length === 0) {
        console.log("No dependencies found.");
        process.exit(0);
      }

      if (outgoing.length > 0) {
        console.log("Outgoing:");
        for (const dep of outgoing) {
          const num = dep.targetNumber != null ? `#${dep.targetNumber}` : "(no number)";
          console.log(`  [${dep.type}] ${num} ${dep.targetTitle} (${dep.targetStatusName})`);
          console.log(`    id: ${dep.id}`);
        }
      }

      if (incoming.length > 0) {
        console.log("Incoming:");
        for (const dep of incoming) {
          const num = dep.sourceNumber != null ? `#${dep.sourceNumber}` : "(no number)";
          console.log(`  [${dep.type}] ${num} ${dep.sourceTitle} (${dep.sourceStatusName})`);
          console.log(`    id: ${dep.id}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

depCmd
  .command("add <issue-id> <target-id>")
  .description("Add a dependency between two issues")
  .option("-t, --type <type>", "Dependency type: depends_on, blocked_by, related_to, duplicates, parent_of, child_of (default: depends_on)")
  .action(async (issueId: string, targetId: string, options: { type?: string }) => {
    try {
      await runMigrations();

      const depType = options.type || "depends_on";
      const validTypes = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"];
      if (!validTypes.includes(depType)) {
        console.error(`Invalid type '${depType}'. Valid types: ${validTypes.join(", ")}`);
        process.exit(1);
      }

      if (issueId === targetId) {
        console.error("An issue cannot depend on itself.");
        process.exit(1);
      }

      const [sourceIssue, targetIssue] = await Promise.all([
        db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1),
        db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, targetId)).limit(1),
      ]);

      if (sourceIssue.length === 0) {
        console.error(`Issue '${issueId}' not found.`);
        process.exit(1);
      }
      if (targetIssue.length === 0) {
        console.error(`Issue '${targetId}' not found.`);
        process.exit(1);
      }
      if (sourceIssue[0].projectId !== targetIssue[0].projectId) {
        console.error("Cannot add dependencies across projects.");
        process.exit(1);
      }

      const id = randomUUID();
      try {
        await db.insert(issueDependencies).values({
          id,
          issueId,
          dependsOnId: targetId,
          type: depType as typeof DEPENDENCY_TYPES[number],
          createdAt: new Date().toISOString(),
        });
      } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint")) {
          console.error("This dependency already exists.");
          process.exit(1);
        }
        throw err;
      }

      console.log(`Added '${depType}' dependency: ${issueId} -> ${targetId}`);
      console.log(`  id: ${id}`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

depCmd
  .command("remove <dependency-id>")
  .description("Remove a dependency by its ID")
  .action(async (dependencyId: string) => {
    try {
      await runMigrations();

      const rows = await db.delete(issueDependencies).where(eq(issueDependencies.id, dependencyId)).returning();
      if (rows.length === 0) {
        console.error(`Dependency '${dependencyId}' not found.`);
        process.exit(1);
      }

      console.log(`Removed dependency '${dependencyId}'.`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program.parse();

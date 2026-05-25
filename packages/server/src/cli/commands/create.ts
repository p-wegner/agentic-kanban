import type { Command } from "commander";
import { db } from "../../db/index.js";
import { projects, projectStatuses, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { runMigrations, DEFAULT_STATUSES, logDefaultBranch } from "../shared.js";

export function registerCreateCommand(program: Command) {
  program
    .command("create")
    .description("Create a new git repo and register it as a project.\n\nCreates a directory under the configured projects_base_path preference (or --path), runs 'git init', and registers the repo.\n\nUse 'pnpm cli -- register <path>' to register an existing repo instead.")
    .argument("<folder-name>", "Name of the new project folder to create")
    .option("--path <base-path>", "Base directory to create the folder in (overrides projects_base_path preference)")
    .option("-n, --name <name>", "Custom project name (defaults to folder name)")
    .option("-b, --branch <branch>", "Initial branch name (default: main)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban create my-app                        # uses projects_base_path preference
  $ agentic-kanban create my-app --path /projects       # create in /projects/my-app
  $ agentic-kanban create my-app -n "My Application"   # custom project name
  $ agentic-kanban create my-app -b master              # use 'master' as initial branch

Setup:
  Set the base folder preference first:
  $ agentic-kanban preferences set projects_base_path /path/to/projects
`)
    .action(async (folderName: string, options: { path?: string; name?: string; branch?: string }) => {
      let cleanup: () => Promise<void> = async () => {};
      try {
        await runMigrations();

        let baseFolder = options.path;
        if (!baseFolder) {
          const pref = await db.select().from(preferences).where(eq(preferences.key, "projects_base_path")).limit(1);
          if (pref.length > 0 && pref[0].value) {
            baseFolder = pref[0].value;
          }
        }

        if (!baseFolder) {
          console.error("No base folder configured. Use --path <base-path> or set the projects_base_path preference:");
          console.error("  pnpm cli -- preferences set projects_base_path /path/to/projects");
          process.exit(1);
        }

        const { mkdir, access, rm } = await import("node:fs/promises");
        const { join, resolve: resolvePath, sep } = await import("node:path");
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);

        const resolvedBase = resolvePath(baseFolder);
        const repoPath = resolvePath(join(resolvedBase, folderName));

        if (!repoPath.startsWith(resolvedBase + sep) && repoPath !== resolvedBase) {
          console.error(`Invalid folder name: "${folderName}" escapes the base directory.`);
          process.exit(1);
        }

        try {
          await access(repoPath);
          console.error(`Directory already exists: ${repoPath}`);
          process.exit(1);
        } catch {
          // Expected: directory doesn't exist yet
        }

        await mkdir(repoPath, { recursive: true });
        let dirCreated = true;

        cleanup = async () => {
          if (dirCreated) {
            try { await rm(repoPath, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        };

        const branch = options.branch ?? "main";
        try {
          await execFileAsync("git", ["-C", repoPath, "init", `-b`, branch]);
        } catch {
          await execFileAsync("git", ["-C", repoPath, "init"]);
          try {
            await execFileAsync("git", ["-C", repoPath, "checkout", "-b", branch]);
          } catch {
            // Branch may already be correct, ignore
          }
        }

        try {
          await execFileAsync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "Initial commit"]);
        } catch (commitErr) {
          await cleanup();
          const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
          if (msg.includes("Please tell me who you are") || msg.includes("user.email") || msg.includes("user.name")) {
            console.error("git commit failed: git user identity not configured.");
            console.error("  Run: git config --global user.email \"you@example.com\"");
            console.error("       git config --global user.name \"Your Name\"");
          } else {
            console.error("git commit failed:", msg);
          }
          process.exit(1);
        }

        const { detectRepoInfo: detectInfo } = await import("../../services/git-info.service.js");
        const repoInfo = await detectInfo(repoPath);
        const projectName = options.name || folderName;

        const existing = await db.select().from(projects).where(eq(projects.repoPath, repoInfo.repoPath)).limit(1);
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
          .values({ key: "activeProjectId", value: projectId, updatedAt: now })
          .onConflictDoUpdate({ target: preferences.key, set: { value: projectId, updatedAt: now } });

        dirCreated = false;
        console.log(`Created and registered project "${projectName}"`);
        console.log(`  Path: ${repoInfo.repoPath}`);
        logDefaultBranch(repoInfo.defaultBranch);
        console.log(`  Statuses: ${DEFAULT_STATUSES.map((s) => s.name).join(", ")}`);
        console.log(`  Set as active project.`);
        process.exit(0);
      } catch (err) {
        await cleanup();
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

import { Hono } from "hono";
import { db } from "../db/index.js";
import { projects, projectStatuses, issues, workspaces, sessions, sessionMessages, diffComments, issueDependencies, preferences, tags, issueTags } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { execFile, execSync } from "node:child_process";
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
=======
import { existsSync, mkdirSync, readdirSync } from "node:fs";
>>>>>>> 41a314b (feat: implement create project flow (WIP - UI + backend route))
=======
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
>>>>>>> 088aead (WIP: add rmSync and writeFileSync imports to projects.ts)
=======
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
>>>>>>> 9e9ee57 (fix: add missing fs imports and unify projects_base_path key name)
=======
import { existsSync, mkdirSync, readdirSync } from "node:fs";
>>>>>>> 73b13d2 (feat: implement create project flow (WIP - UI + backend route))
=======
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
>>>>>>> 14dd44c (WIP: add rmSync and writeFileSync imports to projects.ts)
=======
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
>>>>>>> 5b58bc1 (fix: add missing fs imports and unify projects_base_path key name)
=======
import { existsSync, mkdirSync, readdirSync } from "node:fs";
>>>>>>> e6a6ccb (feat: implement create project flow (WIP - UI + backend route))
=======
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
>>>>>>> 59386e6 (WIP: add rmSync and writeFileSync imports to projects.ts)
=======
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
>>>>>>> 4d8cce7 (fix: add missing fs imports and unify projects_base_path key name)
=======
import { existsSync, mkdirSync, readdirSync } from "node:fs";
>>>>>>> ec12683 (feat: implement create project flow (WIP - UI + backend route))
=======
import { existsSync, mkdirSync, readdirSync } from "node:fs";
=======
import { existsSync, readdirSync, writeFileSync } from "node:fs";
>>>>>>> f36a871 (feat: add optional README and .gitignore template to project creation dialog)
>>>>>>> 27323e9 (feat: add optional README and .gitignore template to project creation dialog)
import { detectRepoInfo } from "../services/git-info.service.js";
import { listBranches, listWorktrees, getDiffShortstat, removeWorktree, detectConflicts } from "../services/git.service.js";
import type { Database } from "../db/index.js";
import { resolve, sep, join } from "node:path";
import { homedir } from "node:os";

const GITIGNORE_TEMPLATES: Record<string, string> = {
  node: `node_modules/
dist/
build/
.env
.env.local
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.DS_Store
`,
  python: `__pycache__/
*.py[cod]
*.egg-info/
dist/
build/
.venv/
venv/
.env
*.log
.DS_Store
`,
  java: `target/
*.class
*.jar
*.war
*.ear
.gradle/
build/
.env
*.log
.DS_Store
`,
  go: `*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out
vendor/
.env
.DS_Store
`,
  rust: `target/
Cargo.lock
*.pdb
.env
.DS_Store
`,
  ruby: `.bundle/
vendor/bundle/
*.gem
*.rbc
.env
log/
tmp/
.DS_Store
`,
  dotnet: `bin/
obj/
*.user
*.suo
.vs/
*.nupkg
.env
.DS_Store
`,
};

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

export function createProjectsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/projects
  router.get("/", async (c) => {
    const result = await database.select().from(projects);
    return c.json(result);
  });

  // POST /api/projects
  router.post("/", async (c) => {
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = randomUUID();

    if (!body.repoPath) {
      return c.json({ error: "repoPath is required" }, 400);
    }

    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(body.repoPath);
    } catch (err) {
      return c.json(
        { error: `Invalid repo: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }

    const name = body.name || repoInfo.repoName;

    // Reject duplicate repo paths
    const existing = await database
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.repoPath, repoInfo.repoPath))
      .limit(1);
    if (existing.length > 0) {
      return c.json({ error: `Project "${existing[0].name}" is already registered at this path` }, 409);
    }

    await database.insert(projects).values({
      id,
      name,
      description: body.description ?? null,
      color: body.color ?? null,
      repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      remoteUrl: repoInfo.remoteUrl,
      createdAt: now,
      updatedAt: now,
    });

    for (const status of DEFAULT_STATUSES) {
      await database.insert(projectStatuses).values({
        id: randomUUID(),
        projectId: id,
        name: status.name,
        sortOrder: status.sortOrder,
        isDefault: status.isDefault,
        createdAt: now,
      });
    }

    // Write optional .gitignore
    if (body.gitignoreTemplate && GITIGNORE_TEMPLATES[body.gitignoreTemplate]) {
      const gitignorePath = join(repoInfo.repoPath, ".gitignore");
      if (!existsSync(gitignorePath)) {
        try {
          writeFileSync(gitignorePath, GITIGNORE_TEMPLATES[body.gitignoreTemplate], "utf8");
        } catch { /* non-fatal */ }
      }
    }

    // Write optional README.md
    if (body.generateReadme) {
      const readmePath = join(repoInfo.repoPath, "README.md");
      if (!existsSync(readmePath)) {
        try {
          writeFileSync(readmePath, `# ${name}\n`, "utf8");
        } catch { /* non-fatal */ }
      }
    }

    return c.json({ id, name, repoPath: repoInfo.repoPath }, 201);
  });

  // POST /api/projects/create — create a new directory as a git repo and register it
  router.post("/create", async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }

    const name = body.name.trim();

    // Resolve target path: explicit path override or baseDir/name
    let targetPath: string;
    if (body.path && body.path.trim()) {
      targetPath = resolve(body.path.trim());
    } else {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 7695053 (feat: validate create-project edge cases (WIP))
=======
>>>>>>> bef4ff5 (feat: validate create-project edge cases (WIP))
=======
>>>>>>> 132b17a (feat: validate create-project edge cases (WIP))
=======
>>>>>>> 405a005 (feat: validate create-project edge cases (WIP))
      // Validate folder name when deriving path from name
      if (/[/\\<>:"|?*\x00]/.test(name)) {
        return c.json({ error: 'Project name contains invalid characters. Avoid: / \\ < > : " | ? *' }, 400);
      }

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
      // Read projects_base_folder from preferences
=======
      // Read projects_base_path from preferences
>>>>>>> 9e9ee57 (fix: add missing fs imports and unify projects_base_path key name)
      const baseDirRows = await database
        .select({ value: preferences.value })
        .from(preferences)
        .where(eq(preferences.key, "projects_base_path"))
        .limit(1);
      const baseDir = baseDirRows[0]?.value?.trim();
      if (!baseDir) {
        return c.json({ error: "No base directory configured. Set 'Projects base directory' in Settings › Project, or provide an explicit path." }, 400);
      }
      targetPath = resolve(join(baseDir, name));

      // Guard against path traversal (e.g. name = "../other")
      const resolvedBase = resolve(baseDir);
      if (!targetPath.startsWith(resolvedBase + sep) && targetPath !== resolvedBase) {
        return c.json({ error: `Invalid project name: "${name}" would escape the base directory.` }, 400);
      }
    }

    // Error if the directory already exists — use the Import tab for existing repos
    if (existsSync(targetPath)) {
      return c.json({ error: `Directory already exists: ${targetPath}. To use an existing directory, use "Import existing" instead.` }, 409);
    }

    try {
      mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      return c.json({ error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

=======
=======
>>>>>>> 7695053 (feat: validate create-project edge cases (WIP))
      // Read projects_base_dir from preferences
=======
      // Read projects_base_folder from preferences
>>>>>>> a19889f (fix: resolve preference key mismatch, path traversal in skill names, and cleanup bugs)
=======
      // Read projects_base_path from preferences
>>>>>>> 5b58bc1 (fix: add missing fs imports and unify projects_base_path key name)
      const baseDirRows = await database
        .select({ value: preferences.value })
        .from(preferences)
        .where(eq(preferences.key, "projects_base_path"))
        .limit(1);
      const baseDir = baseDirRows[0]?.value?.trim();
      if (!baseDir) {
        return c.json({ error: "No base directory configured. Set 'Projects base directory' in Settings › Project, or provide an explicit path." }, 400);
      }
      targetPath = resolve(join(baseDir, name));

      // Guard against path traversal (e.g. name = "../other")
      const resolvedBase = resolve(baseDir);
      if (!targetPath.startsWith(resolvedBase + sep) && targetPath !== resolvedBase) {
        return c.json({ error: `Invalid project name: "${name}" would escape the base directory.` }, 400);
      }
    }

    // Error if the directory already exists — use the Import tab for existing repos
    if (existsSync(targetPath)) {
      return c.json({ error: `Directory already exists: ${targetPath}. To use an existing directory, use "Import existing" instead.` }, 409);
    }

    try {
      mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      return c.json({ error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

>>>>>>> 41a314b (feat: implement create project flow (WIP - UI + backend route))
=======
=======
>>>>>>> bef4ff5 (feat: validate create-project edge cases (WIP))
      // Read projects_base_dir from preferences
=======
      // Read projects_base_folder from preferences
>>>>>>> 9bd4ac7 (fix: resolve preference key mismatch, path traversal in skill names, and cleanup bugs)
=======
      // Read projects_base_path from preferences
>>>>>>> 4d8cce7 (fix: add missing fs imports and unify projects_base_path key name)
      const baseDirRows = await database
        .select({ value: preferences.value })
        .from(preferences)
        .where(eq(preferences.key, "projects_base_path"))
        .limit(1);
      const baseDir = baseDirRows[0]?.value?.trim();
      if (!baseDir) {
        return c.json({ error: "No base directory configured. Set 'Projects base directory' in Settings › Project, or provide an explicit path." }, 400);
      }
      targetPath = resolve(join(baseDir, name));

      // Guard against path traversal (e.g. name = "../other")
      const resolvedBase = resolve(baseDir);
      if (!targetPath.startsWith(resolvedBase + sep) && targetPath !== resolvedBase) {
        return c.json({ error: `Invalid project name: "${name}" would escape the base directory.` }, 400);
      }
    }

    // Error if the directory already exists — use the Import tab for existing repos
    if (existsSync(targetPath)) {
      return c.json({ error: `Directory already exists: ${targetPath}. To use an existing directory, use "Import existing" instead.` }, 409);
    }

    try {
      mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      return c.json({ error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

>>>>>>> 73b13d2 (feat: implement create project flow (WIP - UI + backend route))
=======
=======
>>>>>>> 132b17a (feat: validate create-project edge cases (WIP))
      // Read projects_base_dir from preferences
=======
      // Read projects_base_folder from preferences
>>>>>>> 89b6a74 (fix: resolve preference key mismatch, path traversal in skill names, and cleanup bugs)
      const baseDirRows = await database
        .select({ value: preferences.value })
        .from(preferences)
        .where(eq(preferences.key, "projects_base_folder"))
        .limit(1);
      const baseDir = baseDirRows[0]?.value?.trim();
      if (!baseDir) {
        return c.json({ error: "No base directory configured. Set 'Projects base directory' in Settings › Project, or provide an explicit path." }, 400);
      }
      targetPath = resolve(join(baseDir, name));

      // Guard against path traversal (e.g. name = "../other")
      const resolvedBase = resolve(baseDir);
      if (!targetPath.startsWith(resolvedBase + sep) && targetPath !== resolvedBase) {
        return c.json({ error: `Invalid project name: "${name}" would escape the base directory.` }, 400);
      }
    }

    // Error if the directory already exists — use the Import tab for existing repos
    if (existsSync(targetPath)) {
      return c.json({ error: `Directory already exists: ${targetPath}. To use an existing directory, use "Import existing" instead.` }, 409);
    }

    try {
      mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      return c.json({ error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

>>>>>>> e6a6ccb (feat: implement create project flow (WIP - UI + backend route))
=======
=======
>>>>>>> 405a005 (feat: validate create-project edge cases (WIP))
      // Read projects_base_dir from preferences
      const baseDirRows = await database
        .select({ value: preferences.value })
        .from(preferences)
        .where(eq(preferences.key, "projects_base_dir"))
        .limit(1);
      const baseDir = baseDirRows[0]?.value?.trim();
      if (!baseDir) {
        return c.json({ error: "No base directory configured. Set 'Projects base directory' in Settings › Project, or provide an explicit path." }, 400);
      }
      targetPath = resolve(join(baseDir, name));

      // Guard against path traversal (e.g. name = "../other")
      const resolvedBase = resolve(baseDir);
      if (!targetPath.startsWith(resolvedBase + sep) && targetPath !== resolvedBase) {
        return c.json({ error: `Invalid project name: "${name}" would escape the base directory.` }, 400);
      }
    }

    // Error if the directory already exists — use the Import tab for existing repos
    if (existsSync(targetPath)) {
      return c.json({ error: `Directory already exists: ${targetPath}. To use an existing directory, use "Import existing" instead.` }, 409);
    }

    try {
      mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      return c.json({ error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

>>>>>>> ec12683 (feat: implement create project flow (WIP - UI + backend route))
    // Run git init
    try {
      execSync("git init", { cwd: targetPath, stdio: "pipe" });
    } catch (err: any) {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
=======
>>>>>>> 41a314b (feat: implement create project flow (WIP - UI + backend route))
=======
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
>>>>>>> f6d1a48 (fix: standardize preference key to projects_base_dir, fix validation logic inversion, add cleanup on git init failure)
=======
>>>>>>> 73b13d2 (feat: implement create project flow (WIP - UI + backend route))
=======
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
>>>>>>> c6fd8a4 (fix: standardize preference key to projects_base_dir, fix validation logic inversion, add cleanup on git init failure)
=======
>>>>>>> e6a6ccb (feat: implement create project flow (WIP - UI + backend route))
=======
      try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
>>>>>>> 5ffc0d0 (fix: standardize preference key to projects_base_dir, fix validation logic inversion, add cleanup on git init failure)
=======
>>>>>>> ec12683 (feat: implement create project flow (WIP - UI + backend route))
      return c.json({ error: `git init failed: ${err.stderr ? String(err.stderr).trim() : String(err)}` }, 400);
    }

    // Check for duplicate registration
    const existing = await database
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.repoPath, targetPath))
      .limit(1);
    if (existing.length > 0) {
      return c.json({ error: `Project "${existing[0].name}" is already registered at this path` }, 409);
    }

    let repoInfo;
    try {
      repoInfo = await detectRepoInfo(targetPath);
    } catch (err) {
      return c.json({ error: `Failed to read repo info: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const projectName = body.name?.trim() || repoInfo.repoName;

    await database.insert(projects).values({
      id,
      name: projectName,
      description: body.description ?? null,
      color: body.color ?? null,
      repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName,
      defaultBranch: repoInfo.defaultBranch,
      remoteUrl: repoInfo.remoteUrl,
      createdAt: now,
      updatedAt: now,
    });

    for (const status of DEFAULT_STATUSES) {
      await database.insert(projectStatuses).values({
        id: randomUUID(),
        projectId: id,
        name: status.name,
        sortOrder: status.sortOrder,
        isDefault: status.isDefault,
        createdAt: now,
      });
    }

    return c.json({ id, name: projectName, repoPath: repoInfo.repoPath }, 201);
  });

  // PATCH /api/projects/:id — update project fields
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.color !== undefined) updates.color = body.color;
    if (body.setupScript !== undefined) updates.setupScript = body.setupScript || null;
    if (body.setupBlocking !== undefined) updates.setupBlocking = !!body.setupBlocking;
    if (body.setupEnabled !== undefined) updates.setupEnabled = !!body.setupEnabled;
    if (body.teardownScript !== undefined) updates.teardownScript = body.teardownScript || null;

    await database.update(projects).set(updates).where(eq(projects.id, id));
    return c.json({ id });
  });

  // POST /api/projects/generate-setup-script — AI-generate a setup script for a project
  router.post("/generate-setup-script", async (c) => {
    let body: { projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.projectId) {
      return c.json({ error: "projectId is required" }, 400);
    }

    const projectRows = await database
      .select({ repoPath: projects.repoPath, repoName: projects.repoName })
      .from(projects)
      .where(eq(projects.id, body.projectId))
      .limit(1);
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const { repoPath, repoName } = projectRows[0];

    // Detect project marker files
    const markers = [
      "package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
      "Cargo.toml", "go.mod", "requirements.txt", "Pipfile", "pyproject.toml",
      "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "mix.exs",
      "Makefile", "justfile", "Taskfile.yml",
    ];
    const detected: string[] = [];
    try {
      const files = readdirSync(repoPath);
      for (const f of files) {
        if (markers.includes(f)) detected.push(f);
      }
    } catch {
      // Can't read directory
    }

    // Read agent_command and claude_profile from global preferences
    let agentCommand = "claude";
    let claudeProfile: string | undefined;
    const prefs = await database
      .select({ key: preferences.key, value: preferences.value })
      .from(preferences)
      .where(inArray(preferences.key, ["agent_command", "claude_profile"]));
    for (const p of prefs) {
      if (p.key === "agent_command" && p.value) agentCommand = p.value;
      if (p.key === "claude_profile" && p.value) claudeProfile = p.value;
    }

    if (process.platform === "win32" && agentCommand === "claude") {
      try {
        const resolved = execSync("where claude.exe 2>nul", { encoding: "utf8" }).trim().split("\n")[0]?.trim();
        if (resolved) agentCommand = resolved;
      } catch {}
    }

    const prompt = `You are analyzing a software project to determine the correct setup command(s) to run after cloning the repository into a fresh git worktree.
Based on the files detected in the project root, suggest the appropriate setup command(s) for the project "${repoName}".

IMPORTANT: Respond ONLY with the raw shell command(s) to run. No explanation, no markdown, no code fences.
If multiple commands are needed, chain them with &&.
Use platform-neutral syntax (e.g., "pnpm install" not "npm i", prefer the package manager indicated by lock files).
If no setup is needed, respond with an empty string.

Detected files: ${detected.length > 0 ? detected.join(", ") : "none"}`;

    const args: string[] = ["--output-format", "text", "-p"];
    if (claudeProfile) {
      const settingsPath = join(homedir(), ".claude", `settings_${claudeProfile}.json`);
      if (existsSync(settingsPath)) {
        args.push("--settings", settingsPath);
      }
    }

    let setupScript: string;
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const child = execFile(agentCommand, args, {
          encoding: "utf8",
          timeout: 30000,
          shell: false,
          maxBuffer: 1024 * 1024,
        }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout ?? "");
        });
        child.stdin?.end(prompt);
      });
      setupScript = result.trim();
    } catch (err: any) {
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[generate-setup-script] claude error:", msg);
      return c.json({ error: "AI generation failed", detail: msg }, 500);
    }
    return c.json({ setupScript });
  });

  // POST /api/projects/generate-teardown-script — AI-generate a teardown script for a project
  router.post("/generate-teardown-script", async (c) => {
    let body: { projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.projectId) {
      return c.json({ error: "projectId is required" }, 400);
    }

    const projectRows = await database
      .select({ repoPath: projects.repoPath, repoName: projects.repoName, setupScript: projects.setupScript })
      .from(projects)
      .where(eq(projects.id, body.projectId))
      .limit(1);
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const { repoPath, repoName, setupScript } = projectRows[0];

    // Detect project marker files
    const markers = [
      "package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
      "Cargo.toml", "go.mod", "requirements.txt", "Pipfile", "pyproject.toml",
      "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "mix.exs",
      "Makefile", "justfile", "Taskfile.yml",
    ];
    const detected: string[] = [];
    try {
      const files = readdirSync(repoPath);
      for (const f of files) {
        if (markers.includes(f)) detected.push(f);
      }
    } catch {
      // Can't read directory
    }

    // Read agent_command and claude_profile from global preferences
    let agentCommand = "claude";
    let claudeProfile: string | undefined;
    const prefs = await database
      .select({ key: preferences.key, value: preferences.value })
      .from(preferences)
      .where(inArray(preferences.key, ["agent_command", "claude_profile"]));
    for (const p of prefs) {
      if (p.key === "agent_command" && p.value) agentCommand = p.value;
      if (p.key === "claude_profile" && p.value) claudeProfile = p.value;
    }

    if (process.platform === "win32" && agentCommand === "claude") {
      try {
        const resolved = execSync("where claude.exe 2>nul", { encoding: "utf8" }).trim().split("\n")[0]?.trim();
        if (resolved) agentCommand = resolved;
      } catch {}
    }

    const contextParts: string[] = [];
    if (detected.length > 0) contextParts.push(`Detected files: ${detected.join(", ")}`);
    if (setupScript) contextParts.push(`Current setup script: ${setupScript}`);

    const prompt = `You are analyzing a software project to determine the correct teardown/cleanup command(s) to run before removing a git worktree.
Based on the project context, suggest appropriate teardown command(s) for the project "${repoName}".

The teardown runs in the worktree directory before the worktree is removed after merging. It should clean up:
- Background processes/servers started during setup or by the agent (e.g. dev servers, watchers)
- Large generated directories (e.g. node_modules, build artifacts) to free disk space
- Any temp files or lock files specific to the worktree

IMPORTANT: Respond ONLY with the raw shell command(s) to run. No explanation, no markdown, no code fences.
If multiple commands are needed, chain them with &&.
Use || true for commands that may fail (e.g. "pkill -f dev-server || true").
If no teardown is needed, respond with an empty string.

${contextParts.join("\n")}`;

    const args: string[] = ["--output-format", "text", "-p"];
    if (claudeProfile) {
      const settingsPath = join(homedir(), ".claude", `settings_${claudeProfile}.json`);
      if (existsSync(settingsPath)) {
        args.push("--settings", settingsPath);
      }
    }

    let teardownScript: string;
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const child = execFile(agentCommand, args, {
          encoding: "utf8",
          timeout: 30000,
          shell: false,
          maxBuffer: 1024 * 1024,
        }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout ?? "");
        });
        child.stdin?.end(prompt);
      });
      teardownScript = result.trim();
    } catch (err: any) {
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[generate-teardown-script] claude error:", msg);
      return c.json({ error: "AI generation failed", detail: msg }, 500);
    }
    return c.json({ teardownScript });
  });

  // GET /api/projects/:id/statuses
  router.get("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const result = await database
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder);
    return c.json(result);
  });

  // POST /api/projects/:id/statuses
  router.post("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = randomUUID();

    await database.insert(projectStatuses).values({
      id,
      projectId,
      name: body.name,
      sortOrder: body.sortOrder ?? 0,
      createdAt: now,
    });

    return c.json({ id, projectId, name: body.name }, 201);
  });

  // DELETE /api/projects/:id/statuses/:statusId
  router.delete("/:id/statuses/:statusId", async (c) => {
    const projectId = c.req.param("id");
    const statusId = c.req.param("statusId");

    const statusRows = await database
      .select()
      .from(projectStatuses)
      .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));

    if (statusRows.length === 0) {
      return c.json({ error: "Status not found" }, 404);
    }

    // Prevent deleting a status that has issues
    const linkedIssues = await database
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.statusId, statusId))
      .limit(1);

    if (linkedIssues.length > 0) {
      return c.json({ error: "Cannot delete status with linked issues" }, 409);
    }

    await database.delete(projectStatuses).where(eq(projectStatuses.id, statusId));

    return c.json({ success: true });
  });

  // GET /api/projects/:id/branches
  router.get("/:id/branches", async (c) => {
    const projectId = c.req.param("id");
    const projectRows = await database
      .select({ id: projects.id, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }
    try {
      const branches = await listBranches(projectRows[0].repoPath);
      return c.json(branches);
    } catch (err) {
      return c.json(
        { error: `Failed to list branches: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // GET /api/projects/:id/stats — lightweight project stats (commit count, recent commits, issue counts)
  router.get("/:id/stats", async (c) => {
    const projectId = c.req.param("id");
    const projectRows = await database
      .select({ id: projects.id, repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) return c.json({ error: "Project not found" }, 404);
    const { repoPath, defaultBranch } = projectRows[0];

    let commitCount = 0;
    let recentCommits: { hash: string; message: string; date: string }[] = [];
    try {
      const countOut = execSync(`git rev-list --count ${defaultBranch}`, { cwd: repoPath, timeout: 5000 }).toString().trim();
      commitCount = parseInt(countOut, 10) || 0;
      const logOut = execSync(`git log ${defaultBranch} --oneline --format="%H|%s|%cr" -10`, { cwd: repoPath, timeout: 5000 }).toString().trim();
      recentCommits = logOut.split("\n").filter(Boolean).map((line) => {
        const [hash, message, date] = line.split("|");
        return { hash: hash?.slice(0, 7) ?? "", message: message ?? "", date: date ?? "" };
      });
    } catch { /* git unavailable or no commits */ }

    // Issue counts by status name
    const issueRows = await database
      .select({ statusName: projectStatuses.name, count: sql<number>`count(*)` })
      .from(issues)
      .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .groupBy(projectStatuses.name);
    const issueCounts: Record<string, number> = {};
    for (const row of issueRows) issueCounts[row.statusName] = Number(row.count);

    return c.json({ commitCount, recentCommits, issueCounts });
  });

  // GET /api/projects/:id/worktrees
  router.get("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const { repoPath, defaultBranch } = projectRows[0];

    let gitWorktrees: { path: string; branch: string }[];
    try {
      gitWorktrees = await listWorktrees(repoPath);
    } catch (err) {
      return c.json(
        { error: `Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    // Fetch all non-closed workspaces for this project, join with issues for info
    const projectWorkspaces = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        branch: workspaces.branch,
        workingDir: workspaces.workingDir,
        baseBranch: workspaces.baseBranch,
        isDirect: workspaces.isDirect,
        status: workspaces.status,
        issueNumber: issues.issueNumber,
        issueTitle: issues.title,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(issues.projectId, projectId));

    // Index workspaces by workingDir (normalized path)
    const wsByDir = new Map<string, typeof projectWorkspaces[number]>();
    for (const ws of projectWorkspaces) {
      if (ws.workingDir) {
        wsByDir.set(ws.workingDir.replace(/\//g, sep), ws);
      }
    }

    const result = await Promise.all(
      gitWorktrees.map(async (wt, index) => {
        // First worktree is always the primary checkout (git guarantee)
        const isMain = index === 0;
        const normalizedWtPath = wt.path.replace(/\//g, sep);

        // Match workspace by exact path, or by direct workspace whose workingDir is inside this worktree
        let ws = wsByDir.get(normalizedWtPath);
        if (!ws && isMain) {
          for (const [, candidate] of wsByDir) {
            if (candidate.isDirect && candidate.workingDir && candidate.workingDir.startsWith(normalizedWtPath)) {
              ws = candidate;
              break;
            }
          }
        }

        let diffStats: { filesChanged: number; insertions: number; deletions: number } | undefined;
        if (!isMain) {
          const base = ws?.baseBranch || defaultBranch;
          diffStats = await getDiffShortstat(wt.path, base);
          if (diffStats.filesChanged === 0 && diffStats.insertions === 0 && diffStats.deletions === 0) {
            diffStats = undefined;
          }
        }

        return {
          path: wt.path,
          branch: isMain ? defaultBranch : wt.branch.replace(/^refs\/heads\//, ""),
          isMain,
          workspace: ws ? {
            id: ws.id,
            status: ws.status,
            isDirect: ws.isDirect,
            issueId: ws.issueId,
            issueNumber: ws.issueNumber,
            issueTitle: ws.issueTitle,
          } : undefined,
          diffStats,
        };
      }),
    );

    return c.json(result);
  });

  // DELETE /api/projects/:id/worktrees — remove a worktree (and optionally its workspace)
  router.delete("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json<{ path?: string; workspaceId?: string }>();

    if (!body.path && !body.workspaceId) {
      return c.json({ error: "path or workspaceId is required" }, 400);
    }

    const projectRows = await database
      .select({ repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const { repoPath } = projectRows[0];
    let removedPath = body.path;

    // If workspaceId given, look up the workspace to find its workingDir
    if (body.workspaceId) {
      const wsRows = await database
        .select({ id: workspaces.id, workingDir: workspaces.workingDir })
        .from(workspaces)
        .where(eq(workspaces.id, body.workspaceId))
        .limit(1);

      if (wsRows.length === 0) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      const ws = wsRows[0];
      if (ws.workingDir) removedPath = ws.workingDir;

      // Cascade delete: diff comments → session messages → sessions → workspace
      const wsSessions = await database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.workspaceId, ws.id));

      await database.delete(diffComments).where(eq(diffComments.workspaceId, ws.id));
      if (wsSessions.length > 0) {
        const sessionIds = wsSessions.map(s => s.id);
        await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
      }
      await database.delete(sessions).where(eq(sessions.workspaceId, ws.id));
      await database.delete(workspaces).where(eq(workspaces.id, ws.id));
    }

    // Remove git worktree
    if (removedPath) {
      try {
        await removeWorktree(repoPath, removedPath);
      } catch {
        // Best effort — worktree may already be removed
      }
    }

    return c.json({ success: true });
  });

  // POST /api/projects/:id/worktrees/open — open a worktree folder in the OS file explorer
  router.post("/:id/worktrees/open", async (c) => {
    const body = await c.req.json<{ path: string }>();
    if (!body.path) return c.json({ error: "path is required" }, 400);

    const { spawn } = await import("node:child_process");
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "win32") {
      cmd = "explorer";
      args = [body.path.replace(/\//g, "\\")];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [body.path];
    } else {
      cmd = "xdg-open";
      args = [body.path];
    }

    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return c.json({ success: true });
  });

  // GET /api/projects/:id/board
  router.get("/:id/board", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ id: projects.id, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }

    const statuses = await database
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder);

    const projectIssues = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
        skipAutoReview: issues.skipAutoReview,
        estimate: issues.estimate,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    // Fetch workspace summaries grouped by issueId
    const issueIds = projectIssues.map((i) => i.id);
    const workspaceSummaryMap = new Map<string, { total: number; active: number; idle: number; closed: number; branches: string[]; main?: { id: string; branch: string; status: "active" | "reviewing" | "idle" | "closed"; claudeProfile: string | null; agentCommand: string | null; diffStats?: { filesChanged: number; insertions: number; deletions: number } | null; conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null; lastSessionAt?: string | null } }>();

    if (issueIds.length > 0) {
      const wsRows = await database
        .select({
          issueId: workspaces.issueId,
          status: workspaces.status,
          branch: workspaces.branch,
          count: sql<number>`count(*)`.as("count"),
        })
        .from(workspaces)
        .where(inArray(workspaces.issueId, issueIds))
        .groupBy(workspaces.issueId, workspaces.status, workspaces.branch);

      for (const row of wsRows) {
        let summary = workspaceSummaryMap.get(row.issueId);
        if (!summary) {
          summary = { total: 0, active: 0, idle: 0, closed: 0, branches: [] };
          workspaceSummaryMap.set(row.issueId, summary);
        }
        summary.total += row.count;
        if (row.status === "active" || row.status === "reviewing") {
          summary.active += row.count;
        } else if (row.status === "closed") {
          summary.closed += row.count;
        } else {
          summary.idle += row.count;
        }
        if (!summary.branches.includes(row.branch)) {
          summary.branches.push(row.branch);
        }
      }

      // Determine main workspace per issue (active > idle > closed, tie-break by updatedAt)
      const wsDetailRows = await database
        .select({
          id: workspaces.id,
          issueId: workspaces.issueId,
          branch: workspaces.branch,
          status: workspaces.status,
          updatedAt: workspaces.updatedAt,
          claudeProfile: workspaces.claudeProfile,
          agentCommand: workspaces.agentCommand,
          workingDir: workspaces.workingDir,
          baseBranch: workspaces.baseBranch,
          isDirect: workspaces.isDirect,
          conflictCacheCheckedAt: workspaces.conflictCacheCheckedAt,
          conflictCacheHasConflicts: workspaces.conflictCacheHasConflicts,
          conflictCacheFiles: workspaces.conflictCacheFiles,
        })
        .from(workspaces)
        .where(inArray(workspaces.issueId, issueIds));

      const CONFLICT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
      const mainWorkspaceMap = new Map<string, { id: string; branch: string; status: string; updatedAt: string; claudeProfile: string | null; agentCommand: string | null; workingDir: string | null; baseBranch: string | null; isDirect: boolean; conflictCacheCheckedAt: string | null; conflictCacheHasConflicts: boolean | null; conflictCacheFiles: string | null }>();
      const statusPriority = (s: string) => s === "active" || s === "reviewing" ? 0 : s === "idle" ? 1 : 2;
      for (const row of wsDetailRows) {
        const existing = mainWorkspaceMap.get(row.issueId);
        if (!existing) {
          mainWorkspaceMap.set(row.issueId, row);
          continue;
        }
        const existingP = statusPriority(existing.status);
        const rowP = statusPriority(row.status);
        if (rowP < existingP || (rowP === existingP && row.updatedAt > existing.updatedAt)) {
          mainWorkspaceMap.set(row.issueId, row);
        }
      }

      // Compute diff stats for each main workspace
      const defaultBranch = projectRows[0].defaultBranch;
      const diffStatsPromises: Promise<void>[] = [];

      for (const [issueId, summary] of workspaceSummaryMap) {
        const mainWs = mainWorkspaceMap.get(issueId);
        if (mainWs) {
          summary.main = { id: mainWs.id, branch: mainWs.branch, status: mainWs.status as "active" | "reviewing" | "idle" | "closed", claudeProfile: mainWs.claudeProfile, agentCommand: mainWs.agentCommand };

          if (mainWs.workingDir && mainWs.status !== "closed") {
            const diffRef = mainWs.isDirect ? "HEAD" : (mainWs.baseBranch || defaultBranch);
            const mainRef = summary.main;
            diffStatsPromises.push(
              getDiffShortstat(mainWs.workingDir, diffRef)
                .then(stats => {
                  if (stats.filesChanged > 0 || stats.insertions > 0 || stats.deletions > 0) {
                    mainRef.diffStats = stats;
                  }
                })
                .catch(() => {})
            );
            // Conflict detection for non-direct idle workspaces — stale-while-revalidate
            if (!mainWs.isDirect && mainWs.status === "idle") {
              const cacheAge = mainWs.conflictCacheCheckedAt
                ? Date.now() - new Date(mainWs.conflictCacheCheckedAt).getTime()
                : Infinity;
              if (mainWs.conflictCacheCheckedAt && cacheAge < CONFLICT_CACHE_TTL_MS) {
                // Cache is fresh — use it immediately
                if (mainWs.conflictCacheHasConflicts !== null) {
                  mainRef.conflicts = {
                    hasConflicts: mainWs.conflictCacheHasConflicts ?? false,
                    conflictFiles: mainWs.conflictCacheFiles ? (() => { try { return JSON.parse(mainWs.conflictCacheFiles!); } catch { return []; } })() : [],
                  };
                }
              } else {
                // Cache is stale — recompute and persist in background, serve stale value now
                if (mainWs.conflictCacheCheckedAt && mainWs.conflictCacheHasConflicts !== null) {
                  mainRef.conflicts = {
                    hasConflicts: mainWs.conflictCacheHasConflicts ?? false,
                    conflictFiles: mainWs.conflictCacheFiles ? (() => { try { return JSON.parse(mainWs.conflictCacheFiles!); } catch { return []; } })() : [],
                  };
                }
                const wsId = mainWs.id;
                const baseBranch = mainWs.baseBranch || defaultBranch;
                const workingDir = mainWs.workingDir;
                // Fire-and-forget background refresh
                detectConflicts(workingDir, baseBranch)
                  .then(result => {
                    database
                      .update(workspaces)
                      .set({
                        conflictCacheCheckedAt: new Date().toISOString(),
                        conflictCacheHasConflicts: result.hasConflicts,
                        conflictCacheFiles: JSON.stringify(result.conflictFiles),
                      })
                      .where(eq(workspaces.id, wsId))
                      .catch(() => {});
                  })
                  .catch(() => {});
              }
            }
          }
        }
      }

      if (diffStatsPromises.length > 0) {
        await Promise.all(diffStatsPromises);
      }

      // Fetch latest session per main workspace for timing info
      const mainWsIds = [...mainWorkspaceMap.values()].map(w => w.id);
      if (mainWsIds.length > 0) {
        const sessionRows = await database
          .select({
            workspaceId: sessions.workspaceId,
            status: sessions.status,
            startedAt: sessions.startedAt,
            endedAt: sessions.endedAt,
          })
          .from(sessions)
          .where(inArray(sessions.workspaceId, mainWsIds))
          .orderBy(sessions.startedAt);

        // Group by workspace, pick latest per workspace
        const latestByWs = new Map<string, { status: string; startedAt: string; endedAt: string | null }>();
        for (const s of sessionRows) {
          if (!latestByWs.has(s.workspaceId)) {
            latestByWs.set(s.workspaceId, { status: s.status, startedAt: s.startedAt, endedAt: s.endedAt });
          }
        }

        for (const [issueId, summary] of workspaceSummaryMap) {
          if (summary.main) {
            const sess = latestByWs.get(summary.main.id);
            if (sess) {
              summary.main.lastSessionAt = sess.status === "running" ? sess.startedAt : sess.endedAt;
            }
          }
        }
      }
    }

    // Attach workspace summaries to issues
    const issuesWithSummary: Array<typeof projectIssues[number] & { workspaceSummary?: typeof workspaceSummaryMap extends Map<string, infer V> ? V : never }> = projectIssues.map((issue) => {
      const wsSummary = workspaceSummaryMap.get(issue.id);
      return wsSummary ? { ...issue, workspaceSummary: wsSummary } : issue;
    });

    // Compute isBlocked for each issue
    const issuesWithBlocked: Array<typeof issuesWithSummary[number] & { isBlocked?: boolean }> = [...issuesWithSummary];
    if (issueIds.length > 0) {
      const depRows = await database
        .select({
          issueId: issueDependencies.issueId,
          dependsOnId: issueDependencies.dependsOnId,
          type: issueDependencies.type,
        })
        .from(issueDependencies)
        .where(inArray(issueDependencies.issueId, issueIds));

      // Map each depended-on issue to its status name
      const dependsOnIds = [...new Set(depRows.map(d => d.dependsOnId))];
      const depStatusMap = new Map<string, string>();
      if (dependsOnIds.length > 0) {
        const depStatuses = await database
          .select({ id: issues.id, statusName: projectStatuses.name })
          .from(issues)
          .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
          .where(inArray(issues.id, dependsOnIds));
        for (const ds of depStatuses) depStatusMap.set(ds.id, ds.statusName);
      }

      // Group blocking deps by issue (only depends_on and blocked_by types cause blocking)
      const depsByIssue = new Map<string, { dependsOnId: string; type: string }[]>();
      for (const dep of depRows) {
        let arr = depsByIssue.get(dep.issueId);
        if (!arr) { arr = []; depsByIssue.set(dep.issueId, arr); }
        arr.push({ dependsOnId: dep.dependsOnId, type: dep.type });
      }

      for (let i = 0; i < issuesWithBlocked.length; i++) {
        const issue = issuesWithBlocked[i];
        const deps = depsByIssue.get(issue.id);
        if (deps && deps.length > 0) {
          const isBlocked = deps.some(dep => {
            const isBlockingType = dep.type === "depends_on" || dep.type === "blocked_by";
            if (!isBlockingType) return false;
            const s = depStatusMap.get(dep.dependsOnId);
            return s !== "Done" && s !== "AI Reviewed";
          });
          issuesWithBlocked[i] = { ...issue, isBlocked, dependencyCount: deps.length };
        }
      }
    }

    // Fetch tags for all issues in one query
    const issueTagMap = new Map<string, { id: string; name: string; color: string | null }[]>();
    if (issueIds.length > 0) {
      const tagRows = await database
        .select({ issueId: issueTags.issueId, id: tags.id, name: tags.name, color: tags.color })
        .from(issueTags)
        .innerJoin(tags, eq(issueTags.tagId, tags.id))
        .where(inArray(issueTags.issueId, issueIds));
      for (const row of tagRows) {
        let arr = issueTagMap.get(row.issueId);
        if (!arr) { arr = []; issueTagMap.set(row.issueId, arr); }
        arr.push({ id: row.id, name: row.name, color: row.color });
      }
    }

    const result = statuses.map((s) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      sortOrder: s.sortOrder,
      issues: issuesWithBlocked.filter((i) => i.statusId === s.id).map((i) => ({
        ...i,
        tags: issueTagMap.get(i.id) ?? [],
      })),
    }));

    return c.json(result);
  });

  // GET /api/projects/:id/graph — all issues + all dependencies for graph view
  router.get("/:id/graph", async (c) => {
    const projectId = c.req.param("id");

    const projectRows = await database
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (projectRows.length === 0) return c.json({ error: "Project not found" }, 404);

    const projectIssues = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
        skipAutoReview: issues.skipAutoReview,
        estimate: issues.estimate,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    const issueIds = projectIssues.map((i) => i.id);
    let edges: Array<{ id: string; issueId: string; dependsOnId: string; type: string; issueTitle: string; issueStatusName: string; issueNumber: number | null }> = [];

    if (issueIds.length > 0) {
      edges = await database
        .select({
          id: issueDependencies.id,
          issueId: issueDependencies.issueId,
          dependsOnId: issueDependencies.dependsOnId,
          type: issueDependencies.type,
          issueTitle: issues.title,
          issueStatusName: projectStatuses.name,
          issueNumber: issues.issueNumber,
        })
        .from(issueDependencies)
        .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
        .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .where(inArray(issueDependencies.issueId, issueIds));
    }

    // Compute isBlocked
    const blockedIds = new Set(
      edges
        .filter((e) => e.type === "depends_on" || e.type === "blocked_by")
        .map((e) => e.issueId)
    );

    const nodes = projectIssues.map((i) => ({ ...i, isBlocked: blockedIds.has(i.id) }));

    return c.json({ nodes, edges });
  });

  return router;
}

export const projectsRoute = createProjectsRoute();

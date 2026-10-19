import type { Command } from "commander";
import { getProjectStatusById, deleteProjectStatusById } from "../../repositories/project.repository.js";
import { getFirstIssueIdWithStatus } from "../../repositories/issue.repository.js";
import { BUILTIN_SKILLS } from "../../builtin-skills.js";
import { runMigrations, logDefaultBranch, timeSince, cliAction } from "../shared.js";
import { cliPathArg, invocationCwd } from "../cli-path.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { parseIssueNumberFromBranch } from "@agentic-kanban/shared/lib/branch";
import { resolveBoardServerPort } from "@agentic-kanban/shared/lib/board-server-url";

type BundledSkillsLib = typeof import("@agentic-kanban/shared/lib/bundled-skills");
type BundledSkill = Awaited<ReturnType<BundledSkillsLib["listBundledSkills"]>>[number];
type PromptSkill = (typeof BUILTIN_SKILLS)[number];
type InstallSkillOptions = { names?: string; list?: boolean; user?: boolean; link?: boolean };

async function deleteStatusAction(statusId: string): Promise<void> {
  const status = await getProjectStatusById(statusId);
  if (!status) {
    console.error(`Status "${statusId}" not found.`);
    process.exit(1);
  }
  const linkedId = await getFirstIssueIdWithStatus(statusId);
  if (linkedId) {
    console.error(`Cannot delete status "${status.name}" -- it has linked issues. Move or delete those issues first.`);
    process.exit(1);
  }
  await deleteProjectStatusById(statusId);
  console.log(`Deleted status "${status.name}" (${statusId})`);
  process.exit(0);
}

async function registerInitProject(path: string, name: string | undefined): Promise<void> {
  const { registerProject } = await import("../../services/project-registration.js");
  const { project, created } = await registerProject(path, { name });
  if (!created) {
    console.log(`Project "${project.name}" already registered.`);
    return;
  }
  console.log(`Registered project "${project.name}"`);
  console.log(`  Repo: ${project.repoPath}`);
  logDefaultBranch(project.defaultBranch);
}

async function initAction(path?: string, options?: { name?: string }): Promise<void> {
  try {
    const { ensureDataDir } = await import("../../db/data-dir.js");
    const dataDir = ensureDataDir();
    console.log(`Data directory: ${dataDir}`);

    await runMigrations();
    console.log("Database migrated.");

    const { seed } = await import("../../db/seed.js");
    await seed();

    if (path) await registerInitProject(path, options?.name);

    console.log("\nInitialization complete!");
    if (!path) {
      console.log("Next: register a project with `agentic-kanban init <path>` or `agentic-kanban register <path>`");
    } else {
      console.log("Run `agentic-kanban dev` to start the server.");
    }
    process.exit(0);
  } catch (err) {
    console.error("Error:", errorMessage(err));
    process.exit(1);
  }
}

function printSkillList(bundled: BundledSkill[], promptOnly: readonly PromptSkill[]): void {
  console.log("Bundled skills (directory + references, junctioned on install):");
  if (!bundled.length) console.log("  (none found — the package's skills/ directory is missing)");
  for (const s of bundled) console.log(`  ${s.name} — ${s.description}`);
  console.log("\nPrompt-only built-in skills:");
  for (const s of promptOnly) console.log(`  ${s.name} — ${s.description}`);
}

/** Target skill directories: the agent HOMES for --user, else the project's own .claude/skills. */
async function resolveSkillsDirs(
  lib: BundledSkillsLib,
  options: InstallSkillOptions,
  targetPath: string | undefined,
  hasBundled: boolean,
): Promise<string[]> {
  if (options.user) {
    const dirs = await lib.discoverUserSkillRoots();
    if (!dirs.length) {
      console.error("No user agent directories found (looked for ~/.claude* and ~/.codex). Install an agent CLI first, or pass a project path.");
      process.exit(1);
    }
    return dirs;
  }
  const { join } = await import("node:path");
  const { access } = await import("node:fs/promises");
  const { ensureCodexSkillsLink } = await import("@agentic-kanban/shared/lib/agent-skill-files");
  // Already absolute when given (cliPathArg); invocationCwd() is the omitted default.
  const resolved = targetPath ?? invocationCwd();
  try {
    await access(resolved);
  } catch {
    console.error(`Target path does not exist: ${resolved}`);
    process.exit(1);
  }
  // Prompt-only skills below do this themselves; do it up front so a bundled-only
  // install still leaves Codex pointing at the same directory.
  if (hasBundled) await ensureCodexSkillsLink(resolved);
  return [join(resolved, ".claude", "skills")];
}

/** Installs into one skills dir; returns whether any bundled skill had to be copied instead of linked. */
async function installIntoSkillsDir(
  lib: BundledSkillsLib,
  skillsDir: string,
  selected: { bundled: BundledSkill[]; promptOnly: readonly PromptSkill[] },
  link: boolean,
): Promise<boolean> {
  const { writeAgentSkillFileInto } = await import("@agentic-kanban/shared/lib/agent-skill-files");
  let copiedWithoutLink = false;
  const installed: string[] = [];
  for (const skill of selected.bundled) {
    const result = await lib.installBundledSkill(skill, skillsDir, { link });
    installed.push(`${skill.name} (${result.mode})`);
    if (result.linkError) {
      copiedWithoutLink = true;
      console.warn(`  ! ${skill.name}: could not junction (${result.linkError}) — copied instead`);
    }
  }
  for (const skill of selected.promptOnly) {
    await writeAgentSkillFileInto(skillsDir, { name: skill.name, description: skill.description, prompt: skill.prompt });
    installed.push(skill.name);
  }
  console.log(`Installed ${installed.length} skill(s) to ${skillsDir}:`);
  for (const line of installed) console.log(`  - ${line}`);
  return copiedWithoutLink;
}

async function installSkillAction(targetPath: string | undefined, options: InstallSkillOptions): Promise<void> {
  try {
    const lib = await import("@agentic-kanban/shared/lib/bundled-skills");
    const bundled = await lib.listBundledSkills();
    // `selectSkillsToInstall` owns both selection rules (a bundled directory beats a
    // same-named prompt-only skill; --user is bundled-only by default) — call it rather
    // than re-deriving either one here.
    const { promptOnly } = lib.selectSkillsToInstall({ bundled, promptOnly: BUILTIN_SKILLS });

    if (options.list) {
      printSkillList(bundled, promptOnly);
      process.exit(0);
    }

    const selected = lib.selectSkillsToInstall({
      bundled,
      promptOnly: BUILTIN_SKILLS,
      names: options.names?.split(","),
      user: options.user,
    });
    if (options.names && !selected.bundled.length && !selected.promptOnly.length) {
      const all = [...bundled.map(s => s.name), ...promptOnly.map(s => s.name)].sort();
      console.error(`No matching skills found. Available: ${all.join(", ")}`);
      process.exit(1);
    }

    const skillsDirs = await resolveSkillsDirs(lib, options, targetPath, selected.bundled.length > 0);
    let copiedWithoutLink = false;
    for (const skillsDir of skillsDirs) {
      if (await installIntoSkillsDir(lib, skillsDir, selected, options.link !== false)) copiedWithoutLink = true;
    }

    if (copiedWithoutLink) {
      console.log("\nSome skills were copied rather than linked — re-run this command after upgrading the package.");
    }
    process.exit(0);
  } catch (err) {
    console.error("Error:", errorMessage(err));
    process.exit(1);
  }
}

function openBrowser(url: string, execFile: typeof import("node:child_process").execFile): void {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  execFile(cmd, args, (err) => {
    if (err) console.warn("  Could not open browser:", err.message);
  });
}

async function devAction(options: { port: string; host: string; open: boolean }): Promise<void> {
  try {
    const { dbExists, ensureDataDir } = await import("../../db/data-dir.js");
    if (!dbExists()) {
      console.log("No database found — running first-time setup...");
      ensureDataDir();
      await runMigrations();
      console.log("Database created and migrated.");
      const { seed } = await import("../../db/seed.js");
      await seed();
      console.log();
    }

    const port = Number(options.port);
    const host = options.host;
    process.env.PORT = String(port);
    process.env.KANBAN_HOST = host;

    const { startServer } = await import("../../server-start.js");
    await startServer(port, host);

    console.log(`\n  Agentic Kanban running at http://${host}:${port}`);
    console.log("  Press Ctrl+C to stop\n");

    if (options.open) {
      const { execFile } = await import("node:child_process");
      openBrowser(`http://${host}:${port}`, execFile);
    }
  } catch (err) {
    console.error("Error:", errorMessage(err));
    process.exit(1);
  }
}

interface SessionDir { name: string; path: string; issueNum: number | null }

interface SessionResult {
  issueNum: number | null;
  dir: string;
  file: string;
  fileSizeBytes: number;
  lastModified: string;
  linesParsed: number;
  turns: number;
  lastAssistantText: string | null;
  lastToolCall: string | null;
  stopReason: string | null;
  sessionStarted: boolean;
  agentResponded: boolean;
  sessionId: string | null;
}

/** Worktree session dirs under ~/.claude/projects, optionally narrowed to one issue. */
async function collectSessionDirs(issueArg: string | undefined): Promise<SessionDir[]> {
  const { homedir } = await import("node:os");
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const claudeProjects = join(homedir(), ".claude", "projects");

  let allDirs: SessionDir[] = [];
  try {
    for (const entry of readdirSync(claudeProjects)) {
      // Claude names a session dir after the working directory with separators replaced
      // by `-`, so a worktree's dir carries the branch's `ak-<N>` verbatim. #548: the
      // shared parser instead of two near-identical regexes — still only consulted for
      // entries that are worktree dirs, so an unrelated project dir cannot contribute a
      // number.
      if (!entry.includes("worktrees")) continue;
      allDirs.push({ name: entry, path: join(claudeProjects, entry), issueNum: parseIssueNumberFromBranch(entry) });
    }
  } catch {
    console.error(`Cannot read ${claudeProjects}`);
    process.exit(1);
  }

  if (issueArg) {
    const n = parseInt(issueArg, 10);
    allDirs = allDirs.filter((d) => d.issueNum === n);
    if (allDirs.length === 0) {
      console.error(`No session directory found for issue #${n}`);
      process.exit(1);
    }
  }
  allDirs.sort((a, b) => (a.issueNum ?? 999) - (b.issueNum ?? 999));
  return allDirs;
}

type SessionTail = Pick<
  SessionResult,
  "turns" | "lastAssistantText" | "lastToolCall" | "stopReason" | "sessionStarted" | "agentResponded" | "sessionId"
>;

type AssistantBlock = { type: string; text?: string; name?: string; input?: unknown };

/** Folds one assistant message's content blocks into the running tail summary. */
function foldAssistantMessage(tail: SessionTail, msg: { stop_reason?: string; content?: unknown[] }): void {
  tail.agentResponded = true;
  if (msg.stop_reason) tail.stopReason = msg.stop_reason;
  for (const block of (msg.content ?? []) as AssistantBlock[]) {
    if (block.type === "text" && block.text) {
      tail.lastAssistantText = block.text.replace(/\s+/g, " ").slice(0, 300);
      tail.turns++;
    }
    if (block.type === "tool_use" && block.name) {
      const inputStr = block.input ? JSON.stringify(block.input).slice(0, 80) : "";
      tail.lastToolCall = `${block.name}  ${inputStr}`;
    }
  }
}

function summarizeSessionLines(lines: string[]): SessionTail {
  const tail: SessionTail = {
    turns: 0,
    lastAssistantText: null,
    lastToolCall: null,
    stopReason: null,
    sessionStarted: false,
    agentResponded: false,
    sessionId: null,
  };
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!tail.sessionId && (obj.sessionId as string)) tail.sessionId = obj.sessionId as string;
    if (obj.type === "user") tail.sessionStarted = true;
    if (obj.type === "assistant") foldAssistantMessage(tail, obj.message as { stop_reason?: string; content?: unknown[] });
  }
  return tail;
}

/** The session transcripts of one dir, newest first (only the latest unless `all`). */
async function listSessionFiles(dirPath: string, all: boolean | undefined) {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  let jsonlFiles: { name: string; path: string; mtime: Date; size: number }[] = [];
  try {
    for (const f of readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"))) {
      const fp = join(dirPath, f);
      const st = statSync(fp);
      jsonlFiles.push({ name: f, path: fp, mtime: st.mtime, size: st.size });
    }
    jsonlFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } catch {
    return null;
  }
  return all ? jsonlFiles : jsonlFiles.slice(0, 1);
}

async function collectSessionResults(
  allDirs: SessionDir[],
  options: { all?: boolean },
  tailLines: number,
): Promise<SessionResult[]> {
  const { readFileSync } = await import("node:fs");
  const results: SessionResult[] = [];
  for (const dir of allDirs) {
    const jsonlFiles = await listSessionFiles(dir.path, options.all);
    if (!jsonlFiles) continue;
    for (const jf of jsonlFiles) {
      const allLines = readFileSync(jf.path, "utf8").split("\n").filter(Boolean);
      const linesToParse = allLines.slice(Math.max(0, allLines.length - tailLines));
      const tail = summarizeSessionLines(linesToParse);
      results.push({
        issueNum: dir.issueNum,
        dir: dir.name,
        file: jf.name.replace(".jsonl", "").slice(0, 8) + "--",
        fileSizeBytes: jf.size,
        lastModified: jf.mtime.toISOString(),
        linesParsed: linesToParse.length,
        ...tail,
        sessionId: tail.sessionId ? tail.sessionId.slice(0, 8) + "--" : null,
      });
    }
  }
  return results;
}

function printSessionResults(results: SessionResult[], tailLines: number): void {
  console.log(`\n  Claude Session History  (tail: ${tailLines} lines/file)\n`);

  let currentIssue: number | null = -1;
  for (const r of results) {
    if (r.issueNum !== currentIssue) {
      currentIssue = r.issueNum;
      console.log(`  -- #${r.issueNum ?? "?"} ----------------------------------`);
    }
    const size = r.fileSizeBytes < 1024 ? `${r.fileSizeBytes}B` : `${(r.fileSizeBytes / 1024).toFixed(0)}KB`;
    const age = timeSince(new Date(r.lastModified));
    const started = r.sessionStarted ? (r.agentResponded ? "OK responded" : "FAIL no response") : "FAIL no prompt";
    console.log(`  ${r.file}  ${size}  ${age} ago  [${started}]  turns:${r.turns}`);
    if (r.stopReason) console.log(`    stop_reason: ${r.stopReason}`);
    if (r.lastToolCall) console.log(`    last tool:   ${r.lastToolCall}`);
    if (r.lastAssistantText) console.log(`    last text:   ${r.lastAssistantText.slice(0, 200)}`);
    console.log("");
  }

  if (results.length === 0) console.log("  No session files found.\n");
}

async function sessionHistoryAction(
  issueArg: string | undefined,
  options: { tail?: string; all?: boolean; json?: boolean },
): Promise<void> {
  const tailLines = parseInt(options.tail ?? "60", 10);
  const allDirs = await collectSessionDirs(issueArg);
  const results = await collectSessionResults(allDirs, options, tailLines);

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }
  printSessionResults(results, tailLines);
  process.exit(0);
}

export function registerSystemCommands(program: Command) {
  program
    .command("delete-status <status-id>")
    .description("Delete a project status (fails if issues are linked to it)")
    .action(cliAction(deleteStatusAction));

  program
    .command("init")
    .description("Initialize agentic-kanban for the first time.\n\nCreates the data directory (~/.agentic-kanban/), runs database migrations, seeds default tags and skills, and optionally registers a project.")
    .argument("[path]", "Path to a git repository to register as a project, relative to the directory you run the command in", cliPathArg)
    .option("-n, --name <name>", "Custom project name (defaults to repo directory name)")
    .addHelpText("after", `
Examples:
  $ npx agentic-kanban init                  # set up data dir only
  $ npx agentic-kanban init .                # set up + register current repo
  $ npx agentic-kanban init /path/to/repo    # set up + register specific repo
`)
    .action(initAction);

  program
    .command("install-skill")
    .description("Install agent skills into a project's .claude/skills/ directory, or into your user agent-skill directories with --user.\n\nWorks without a running server or database. Prompt-only built-ins are written as .claude/skills/<name>/SKILL.md; BUNDLED skills (which carry a references/ directory) are junctioned into the installed package by default, so `npm update agentic-kanban` refreshes them with no re-install. --user installs only BUNDLED skills unless a prompt-only built-in is named with -n, since those are per-project working prompts.")
    // No commander default: a default value is NOT passed through the parser, so a literal
    // "." would still resolve against packages/server under `pnpm cli --` (#1038). The
    // handler defaults to invocationCwd() instead.
    .argument("[target-path]", "Path to the target project (defaults to the directory you run the command in)", cliPathArg)
    .option("-n, --names <names>", "Comma-separated list of skill names to install (default: all)")
    .option("--user", "Install into your user agent-skill directories (~/.claude*/skills, ~/.codex/skills) instead of a project. Bundled skills only, unless -n names a prompt-only built-in")
    .option("--no-link", "Copy bundled skills instead of junctioning them (they will not track package upgrades)")
    .option("--list", "List available skills without installing")
    .addHelpText("after", `
Examples:
  $ npx agentic-kanban install-skill                        # install all skills to cwd
  $ npx agentic-kanban install-skill /path/to/project       # install to a specific project
  $ npx agentic-kanban install-skill --user                 # bundled skills, every agent profile on this machine
  $ npx agentic-kanban install-skill --user -n "code-review" # ...plus a named prompt-only built-in
  $ npx agentic-kanban install-skill -n "board-navigator"   # install a single skill
  $ npx agentic-kanban install-skill --list                  # list available skills

Bundled vs prompt-only:
  A BUNDLED skill is a directory shipped with the package (SKILL.md + references/). It is junctioned,
  so it stays current across upgrades — verify with 'agentic-kanban skill verify'. A junction is not
  always possible (npx cache, no symlink permission); a copy is made instead and reported as such.
  A PROMPT-ONLY built-in is a single SKILL.md the board also materializes into worktrees itself.
  Those are per-project working prompts, so --user installs only BUNDLED skills unless you name one
  with -n; a project target still gets both.
`)
    .action(installSkillAction);

  program
    .command("dev")
    .description("Start the development server (server + built client UI)")
    .option("-p, --port <port>", "Server port", String(resolveBoardServerPort()))
    .option("-H, --host <host>", "Server hostname", process.env.KANBAN_HOST || "127.0.0.1")
    .option("--no-open", "Do not open browser")
    .addHelpText("after", `
Environment:
  KANBAN_HOST       Bind address (same as --host). Use 0.0.0.0 (or a Tailscale/LAN IP)
                    to accept connections from other machines.
  KANBAN_TLS_CERT   Path to a PEM certificate. Set together with KANBAN_TLS_KEY to serve
                    over TLS with HTTP/2 (keeps an HTTP/1.1 + WebSocket fallback). Unset,
                    the server stays plain HTTP/1.1. Browsers only negotiate HTTP/2 over TLS.
  KANBAN_TLS_KEY    Path to the PEM private key paired with KANBAN_TLS_CERT.

Network access example (HTTP/2 over TLS):
  $ KANBAN_HOST=0.0.0.0 KANBAN_TLS_CERT=./board.crt KANBAN_TLS_KEY=./board.key agentic-kanban dev
    (Tailscale: 'tailscale cert <name>.ts.net' issues a trusted cert/key.)
`)
    .action(devAction);

  const sessionDebugCmd = program
    .command("session-history [issue-number]")
    .alias("sh")
    .description(
      "Inspect Claude Code session transcript files from ~/.claude/projects/.\n\nParses JSONL session files for worktrees linked to this project's issues, showing what the agent did and why it stopped -- without loading entire large files."
    )
    .option("-t, --tail <lines>", "Number of tail lines to parse per session file (default: 60)", "60")
    .option("-a, --all", "Show all sessions for the issue, not just the latest", false)
    .option("--json", "Output raw JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ agentic-kanban session-history           # all issues with session dirs
  $ agentic-kanban sh 17                     # inspect issue #17 sessions
  $ agentic-kanban sh 23 --all               # all session files for #23
  $ agentic-kanban sh 17 --tail 100          # parse more lines for detail
  $ agentic-kanban sh --json                 # machine-readable output

Via pnpm (use -- to pass args):
  $ pnpm sh -- 17
  $ pnpm sh -- 17 --all
`
    )
    .action(sessionHistoryAction);

  void sessionDebugCmd;
}

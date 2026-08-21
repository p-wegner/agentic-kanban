import type { Command } from "commander";
import { getProjectStatusById, deleteProjectStatusById } from "../../repositories/project.repository.js";
import { getFirstIssueIdWithStatus } from "../../repositories/issue.repository.js";
import { BUILTIN_SKILLS } from "../../builtin-skills.js";
import { runMigrations, logDefaultBranch, timeSince, cliAction } from "../shared.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { parseIssueNumberFromBranch } from "@agentic-kanban/shared/lib/branch";
import { resolveBoardServerPort } from "@agentic-kanban/shared/lib/board-server-url";

export function registerSystemCommands(program: Command) {
  program
    .command("delete-status <status-id>")
    .description("Delete a project status (fails if issues are linked to it)")
    .action(cliAction(async (statusId: string) => {
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
    }));

  program
    .command("init")
    .description("Initialize agentic-kanban for the first time.\n\nCreates the data directory (~/.agentic-kanban/), runs database migrations, seeds default tags and skills, and optionally registers a project.")
    .argument("[path]", "Path to a git repository to register as a project")
    .option("-n, --name <name>", "Custom project name (defaults to repo directory name)")
    .addHelpText("after", `
Examples:
  $ npx agentic-kanban init                  # set up data dir only
  $ npx agentic-kanban init .                # set up + register current repo
  $ npx agentic-kanban init /path/to/repo    # set up + register specific repo
`)
    .action(async (path?: string, options?: { name?: string }) => {
      try {
        const { ensureDataDir } = await import("../../db/data-dir.js");
        const dataDir = ensureDataDir();
        console.log(`Data directory: ${dataDir}`);

        await runMigrations();
        console.log("Database migrated.");

        const { seed } = await import("../../db/seed.js");
        await seed();

        if (path) {
          const { registerProject } = await import("../../services/project-registration.js");
          const { project, created } = await registerProject(path, { name: options?.name });
          if (!created) {
            console.log(`Project "${project.name}" already registered.`);
          } else {
            console.log(`Registered project "${project.name}"`);
            console.log(`  Repo: ${project.repoPath}`);
            logDefaultBranch(project.defaultBranch);
          }
        }

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
    });

  program
    .command("install-skill")
    .description("Install agent skills into a project's .claude/skills/ directory, or into your user agent-skill directories with --user.\n\nWorks without a running server or database. Prompt-only built-ins are written as .claude/skills/<name>/SKILL.md; BUNDLED skills (which carry a references/ directory) are junctioned into the installed package by default, so `npm update agentic-kanban` refreshes them with no re-install. --user installs only BUNDLED skills unless a prompt-only built-in is named with -n, since those are per-project working prompts.")
    .argument("[target-path]", "Path to the target project (defaults to current directory)", ".")
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
    .action(async (targetPath: string, options: { names?: string; list?: boolean; user?: boolean; link?: boolean }) => {
      try {
        const { listBundledSkills, installBundledSkill, discoverUserSkillRoots, selectSkillsToInstall } =
          await import("@agentic-kanban/shared/lib/bundled-skills");
        const bundled = await listBundledSkills();
        // `selectSkillsToInstall` owns both selection rules (a bundled directory beats a
        // same-named prompt-only skill; --user is bundled-only by default) — call it rather
        // than re-deriving either one here.
        const { promptOnly } = selectSkillsToInstall({ bundled, promptOnly: BUILTIN_SKILLS });

        if (options.list) {
          console.log("Bundled skills (directory + references, junctioned on install):");
          if (!bundled.length) console.log("  (none found — the package's skills/ directory is missing)");
          for (const s of bundled) console.log(`  ${s.name} — ${s.description}`);
          console.log("\nPrompt-only built-in skills:");
          for (const s of promptOnly) console.log(`  ${s.name} — ${s.description}`);
          process.exit(0);
        }

        const { bundled: selectedBundled, promptOnly: selectedPrompt } = selectSkillsToInstall({
          bundled,
          promptOnly: BUILTIN_SKILLS,
          names: options.names?.split(","),
          user: options.user,
        });
        if (options.names && !selectedBundled.length && !selectedPrompt.length) {
          const all = [...bundled.map(s => s.name), ...promptOnly.map(s => s.name)].sort();
          console.error(`No matching skills found. Available: ${all.join(", ")}`);
          process.exit(1);
        }

        const { resolve: resolvePath, join } = await import("node:path");
        const { access } = await import("node:fs/promises");
        const { writeAgentSkillFileInto, ensureCodexSkillsLink } =
          await import("@agentic-kanban/shared/lib/agent-skill-files");

        // --user targets the agent HOMES directly (~/.claude/skills); a project target goes
        // through the project's own .claude/skills, with .codex linked to it as usual.
        let skillsDirs: string[];
        if (options.user) {
          skillsDirs = await discoverUserSkillRoots();
          if (!skillsDirs.length) {
            console.error("No user agent directories found (looked for ~/.claude* and ~/.codex). Install an agent CLI first, or pass a project path.");
            process.exit(1);
          }
        } else {
          const resolved = resolvePath(targetPath);
          try {
            await access(resolved);
          } catch {
            console.error(`Target path does not exist: ${resolved}`);
            process.exit(1);
          }
          skillsDirs = [join(resolved, ".claude", "skills")];
          // Prompt-only skills below do this themselves; do it up front so a bundled-only
          // install still leaves Codex pointing at the same directory.
          if (selectedBundled.length) await ensureCodexSkillsLink(resolved);
        }

        let copiedWithoutLink = false;
        for (const skillsDir of skillsDirs) {
          const installed: string[] = [];
          for (const skill of selectedBundled) {
            const result = await installBundledSkill(skill, skillsDir, { link: options.link !== false });
            installed.push(`${skill.name} (${result.mode})`);
            if (result.linkError) {
              copiedWithoutLink = true;
              console.warn(`  ! ${skill.name}: could not junction (${result.linkError}) — copied instead`);
            }
          }
          for (const skill of selectedPrompt) {
            await writeAgentSkillFileInto(skillsDir, { name: skill.name, description: skill.description, prompt: skill.prompt });
            installed.push(skill.name);
          }
          console.log(`Installed ${installed.length} skill(s) to ${skillsDir}:`);
          for (const line of installed) console.log(`  - ${line}`);
        }

        if (copiedWithoutLink) {
          console.log("\nSome skills were copied rather than linked — re-run this command after upgrading the package.");
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", errorMessage(err));
        process.exit(1);
      }
    });

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
    .action(async (options: { port: string; host: string; open: boolean }) => {
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
          const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
          const args = process.platform === "win32" ? ["/c", "start", `http://${host}:${port}`] : [`http://${host}:${port}`];
          execFile(cmd, args, (err) => {
            if (err) console.warn("  Could not open browser:", err.message);
          });
        }
      } catch (err) {
        console.error("Error:", errorMessage(err));
        process.exit(1);
      }
    });

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
    .action(
      async (issueArg: string | undefined, options: { tail?: string; all?: boolean; json?: boolean }) => {
        const issueNumber = issueArg;
        const { homedir } = await import("node:os");
        const { readdirSync, statSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");

        const claudeProjects = join(homedir(), ".claude", "projects");
        const tailLines = parseInt(options.tail ?? "60", 10);

        let allDirs: { name: string; path: string; issueNum: number | null }[] = [];
        try {
          const entries = readdirSync(claudeProjects);
          for (const entry of entries) {
            // Claude names a session dir after the working directory with separators replaced
            // by `-`, so a worktree's dir carries the branch's `ak-<N>` verbatim. #548: the
            // shared parser instead of two near-identical regexes — still only consulted for
            // entries that are worktree dirs, so an unrelated project dir cannot contribute a
            // number.
            if (!entry.includes("worktrees")) continue;
            const issueNum = parseIssueNumberFromBranch(entry);
            allDirs.push({ name: entry, path: join(claudeProjects, entry), issueNum });
          }
        } catch {
          console.error(`Cannot read ${claudeProjects}`);
          process.exit(1);
        }

        if (issueNumber) {
          const n = parseInt(issueNumber, 10);
          allDirs = allDirs.filter((d) => d.issueNum === n);
          if (allDirs.length === 0) {
            console.error(`No session directory found for issue #${n}`);
            process.exit(1);
          }
        }

        allDirs.sort((a, b) => (a.issueNum ?? 999) - (b.issueNum ?? 999));

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

        const results: SessionResult[] = [];

        for (const dir of allDirs) {
          let jsonlFiles: { name: string; path: string; mtime: Date; size: number }[] = [];
          try {
            const files = readdirSync(dir.path).filter((f) => f.endsWith(".jsonl"));
            for (const f of files) {
              const fp = join(dir.path, f);
              const st = statSync(fp);
              jsonlFiles.push({ name: f, path: fp, mtime: st.mtime, size: st.size });
            }
            jsonlFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
          } catch {
            continue;
          }

          if (!options.all) jsonlFiles = jsonlFiles.slice(0, 1);

          for (const jf of jsonlFiles) {
            const raw = readFileSync(jf.path, "utf8");
            const allLines = raw.split("\n").filter(Boolean);
            const tailStart = Math.max(0, allLines.length - tailLines);
            const linesToParse = allLines.slice(tailStart);

            let turns = 0;
            let lastAssistantText: string | null = null;
            let lastToolCall: string | null = null;
            let stopReason: string | null = null;
            let sessionStarted = false;
            let agentResponded = false;
            let sessionId: string | null = null;

            for (const line of linesToParse) {
              let obj: Record<string, unknown>;
              try {
                obj = JSON.parse(line) as Record<string, unknown>;
              } catch {
                continue;
              }

              if (!sessionId && (obj.sessionId as string)) sessionId = obj.sessionId as string;

              const type = obj.type as string;
              if (type === "user") sessionStarted = true;

              if (type === "assistant") {
                agentResponded = true;
                const msg = obj.message as { role: string; stop_reason?: string; content?: unknown[] };
                if (msg.stop_reason) stopReason = msg.stop_reason;
                const content = msg.content ?? [];
                for (const block of content as { type: string; text?: string; name?: string; input?: unknown }[]) {
                  if (block.type === "text" && block.text) {
                    lastAssistantText = block.text.replace(/\s+/g, " ").slice(0, 300);
                    turns++;
                  }
                  if (block.type === "tool_use" && block.name) {
                    const inputStr = block.input ? JSON.stringify(block.input).slice(0, 80) : "";
                    lastToolCall = `${block.name}  ${inputStr}`;
                  }
                }
              }
            }

            results.push({
              issueNum: dir.issueNum,
              dir: dir.name,
              file: jf.name.replace(".jsonl", "").slice(0, 8) + "--",
              fileSizeBytes: jf.size,
              lastModified: jf.mtime.toISOString(),
              linesParsed: linesToParse.length,
              turns,
              lastAssistantText,
              lastToolCall,
              stopReason,
              sessionStarted,
              agentResponded,
              sessionId: sessionId ? (sessionId).slice(0, 8) + "--" : null,
            });
          }
        }

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
          process.exit(0);
        }

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

        process.exit(0);
      }
    );

  void sessionDebugCmd;
}

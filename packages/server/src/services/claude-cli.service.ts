import { execFile, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db } from "../db/index.js";
import { preferences } from "@agentic-kanban/shared/schema";
import { inArray } from "drizzle-orm";
import { buildSpawnEnv } from "./agent-provider.js";
import type { Database } from "../db/index.js";

export interface ClaudeCliOptions {
  timeout?: number;
  database?: Database;
}

export async function invokeClaudePrompt(
  prompt: string,
  opts: ClaudeCliOptions = {}
): Promise<string> {
  const { timeout = 60000, database = db } = opts;

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

  const args: string[] = ["--output-format", "text"];
  if (claudeProfile) {
    const settingsPath = join(homedir(), ".claude", `settings_${claudeProfile}.json`);
    if (existsSync(settingsPath)) {
      args.push("--settings", settingsPath);
    }
  }
  args.push("-p");

  return new Promise<string>((resolve, reject) => {
    const child = execFile(agentCommand, args, {
      encoding: "utf8",
      timeout,
      shell: false,
      maxBuffer: 1024 * 1024,
      env: buildSpawnEnv(claudeProfile),
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout ?? "");
    });
    child.stdin?.end(prompt);
  });
}

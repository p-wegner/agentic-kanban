import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projects, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { SessionManager } from "./session.manager.js";
import { WorkspaceError } from "./workspace-internals.js";

export type BisectScope = "related" | "full";

export interface BisectResult {
  status: "found" | "inconclusive" | "failed";
  breakingCommitSha: string | null;
  message: string | null;
  diffStat: string | null;
  failingTestName: string | null;
  skippedCommits: string[];
  testedCommits: Array<{ sha: string; result: "good" | "bad" | "skip"; exitCode: number | null }>;
  scope: BisectScope;
  changedFiles: string[];
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout.toString());
    });
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function trimOutput(output: string, max = 200_000): string {
  return output.length <= max ? output : output.slice(output.length - max);
}

function extractFirstBadCommit(output: string): string | null {
  const direct = output.match(/^([0-9a-f]{7,40}) is the first bad commit/im);
  if (direct) return direct[1];
  const commitLine = output.match(/^commit ([0-9a-f]{7,40})$/im);
  return commitLine?.[1] ?? null;
}

function extractFailingTestName(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(?:x\s+|FAIL\s+)(.+)$/i);
    if (match) return match[1].trim();
  }
  for (const line of lines) {
    const match = line.match(/>\s*([^>]+)$/);
    if (match && /fail|error|should|test/i.test(match[1])) return match[1].trim();
  }
  return null;
}

function isSkippableFailure(exitCode: number | null, output: string): boolean {
  if (exitCode === 125) return true;
  return [
    "No test files found",
    "Cannot find module",
    "Failed to load",
    "Transform failed",
    "Build failed",
  ].some((needle) => output.includes(needle));
}

function formatResult(result: BisectResult): string {
  if (result.status === "found" && result.breakingCommitSha) {
    return [
      "Auto-bisect identified the breaking commit.",
      "",
      `Breaking commit: ${result.breakingCommitSha}`,
      `Message: ${result.message ?? "(no message)"}`,
      `Failing test: ${result.failingTestName ?? "(not detected)"}`,
      `Scope: ${result.scope}`,
      result.changedFiles.length > 0 ? `Related files: ${result.changedFiles.join(", ")}` : null,
      result.skippedCommits.length > 0 ? `Skipped commits: ${result.skippedCommits.join(", ")}` : null,
      "",
      "Diff stat:",
      result.diffStat ?? "(unavailable)",
    ].filter((line): line is string => line !== null).join("\n");
  }

  return [
    `Auto-bisect finished with status: ${result.status}.`,
    result.skippedCommits.length > 0 ? `Skipped commits: ${result.skippedCommits.join(", ")}` : null,
    result.testedCommits.length > 0 ? `Tested commits: ${result.testedCommits.map((t) => `${shortSha(t.sha)}=${t.result}`).join(", ")}` : null,
  ].filter((line): line is string => line !== null).join("\n");
}

export function createBisectService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
}) {
  const { database, getSessionManager, boardEvents } = deps;

  async function emit(sessionId: string, message: AgentOutputMessage) {
    const manager = getSessionManager?.();
    if (typeof manager?.handleOutput === "function") {
      manager.handleOutput(sessionId, message);
      return;
    }
    await database.insert(sessionMessages).values({
      sessionId,
      type: message.type,
      data: message.data ?? null,
      exitCode: message.exitCode != null ? String(message.exitCode) : null,
    });
  }

  async function emitLine(sessionId: string, line: string) {
    await emit(sessionId, { type: "stdout", sessionId, data: `${line}\n` });
  }

  async function runTests(sessionId: string, cwd: string, scope: BisectScope, changedFiles: string[]) {
    const args = ["--filter", "agentic-kanban", "test", "--", "--reporter=verbose"];
    if (scope === "related" && changedFiles.length > 0) {
      args.push("--related", ...changedFiles);
    }
    const display = `pnpm ${args.join(" ")}`;
    await emitLine(sessionId, `$ ${display}`);

    return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const command = process.platform === "win32" ? "cmd.exe" : "pnpm";
      const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...args] : args;
      const child = spawn(command, commandArgs, { cwd, windowsHide: true, shell: false });
      let output = "";
      child.stdout?.on("data", (chunk) => {
        const data = chunk.toString();
        output = trimOutput(output + data);
        void emit(sessionId, { type: "stdout", sessionId, data });
      });
      child.stderr?.on("data", (chunk) => {
        const data = chunk.toString();
        output = trimOutput(output + data);
        void emit(sessionId, { type: "stderr", sessionId, data });
      });
      child.on("error", (err) => {
        const data = `${err.message}\n`;
        output = trimOutput(output + data);
        void emit(sessionId, { type: "stderr", sessionId, data });
        resolve({ exitCode: 127, output });
      });
      child.on("close", (code) => resolve({ exitCode: code, output }));
    });
  }

  async function finishSession(workspaceId: string, sessionId: string, exitCode: number, result?: BisectResult) {
    const now = new Date().toISOString();
    if (result) {
      await emit(sessionId, { type: "bisect", sessionId, data: JSON.stringify(result) });
      await emitLine(sessionId, `\n${formatResult(result)}`);
    }
    await emit(sessionId, { type: "exit", sessionId, exitCode });
    await database.update(sessions)
      .set({ status: "completed", endedAt: now, exitCode: String(exitCode) })
      .where(eq(sessions.id, sessionId));
    await database.update(workspaces)
      .set({ status: "idle", updatedAt: now })
      .where(eq(workspaces.id, workspaceId));
  }

  async function runBisect(workspaceId: string, sessionId: string, scope: BisectScope) {
    let resetNeeded = false;
    let resetWorkingDir: string | null = null;
    let projectId: string | null = null;
    let exitCode = 1;
    try {
      const rows = await database
        .select({
          workspace: workspaces,
          projectId: issues.projectId,
          repoPath: projects.repoPath,
        })
        .from(workspaces)
        .innerJoin(issues, eq(workspaces.issueId, issues.id))
        .innerJoin(projects, eq(issues.projectId, projects.id))
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      const row = rows[0];
      if (!row) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
      const workspace = row.workspace;
      projectId = row.projectId;
      if (!workspace.workingDir) throw new WorkspaceError("Workspace has no working directory", "BAD_REQUEST");
      if (!workspace.baseCommitSha) throw new WorkspaceError("Workspace has no base commit SHA to use as the good commit", "BAD_REQUEST");
      resetWorkingDir = workspace.workingDir;

      const dirty = (await execGit(["status", "--porcelain"], workspace.workingDir)).trim();
      if (dirty) throw new WorkspaceError("Working tree must be clean before auto-bisect can run", "CONFLICT");

      const badSha = (await execGit(["rev-parse", "HEAD"], workspace.workingDir)).trim();
      const goodSha = workspace.baseCommitSha;
      const changedFiles = (await execGit(["diff", "--name-only", `${goodSha}..${badSha}`], workspace.workingDir))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      await emitLine(sessionId, `Auto-bisect starting: bad=${badSha} good=${goodSha} scope=${scope}`);
      if (scope === "related") {
        await emitLine(sessionId, changedFiles.length > 0
          ? `Related test scope files: ${changedFiles.join(", ")}`
          : "No changed files detected; falling back to full test suite.");
      }

      await execGit(["bisect", "start", badSha, goodSha], workspace.workingDir);
      resetNeeded = true;

      const result: BisectResult = {
        status: "inconclusive",
        breakingCommitSha: null,
        message: null,
        diffStat: null,
        failingTestName: null,
        skippedCommits: [],
        testedCommits: [],
        scope,
        changedFiles,
      };

      const seen = new Set<string>();
      for (let step = 1; step <= 100; step++) {
        const current = (await execGit(["rev-parse", "HEAD"], workspace.workingDir)).trim();
        if (seen.has(current)) {
          await emitLine(sessionId, `Stopping: git bisect revisited ${current}.`);
          break;
        }
        seen.add(current);
        await emitLine(sessionId, `\n[${step}] Testing ${current}`);

        const test = await runTests(sessionId, workspace.workingDir, scope, changedFiles);
        const output = trimOutput(test.output);
        if (test.exitCode === 0) {
          result.testedCommits.push({ sha: current, result: "good", exitCode: 0 });
          const markOutput = await execGit(["bisect", "good"], workspace.workingDir);
          await emitLine(sessionId, `Marked ${shortSha(current)} good.`);
          const firstBad = extractFirstBadCommit(markOutput);
          if (firstBad) {
            result.breakingCommitSha = firstBad;
            result.status = "found";
            break;
          }
          continue;
        }

        if (isSkippableFailure(test.exitCode, output)) {
          result.testedCommits.push({ sha: current, result: "skip", exitCode: test.exitCode });
          result.skippedCommits.push(current);
          const markOutput = await execGit(["bisect", "skip"], workspace.workingDir);
          await emitLine(sessionId, `Skipped ${shortSha(current)} because the test command could not run cleanly.`);
          if (markOutput.includes("only 'skip'ped commits left")) break;
          continue;
        }

        result.testedCommits.push({ sha: current, result: "bad", exitCode: test.exitCode });
        result.failingTestName ??= extractFailingTestName(output);
        const markOutput = await execGit(["bisect", "bad"], workspace.workingDir);
        await emitLine(sessionId, `Marked ${shortSha(current)} bad.`);
        const firstBad = extractFirstBadCommit(markOutput);
        if (firstBad) {
          result.breakingCommitSha = firstBad;
          result.status = "found";
          break;
        }
      }

      if (result.breakingCommitSha) {
        result.message = (await execGit(["log", "-1", "--format=%s", result.breakingCommitSha], workspace.workingDir)).trim();
        result.diffStat = (await execGit(["show", "--stat", "--oneline", "--summary", "--no-renames", result.breakingCommitSha], workspace.workingDir)).trim();
        exitCode = 0;
      }

      if (resetNeeded) {
        await execGit(["bisect", "reset"], workspace.workingDir);
        resetNeeded = false;
      }
      await finishSession(workspaceId, sessionId, exitCode, result);
      if (projectId) boardEvents?.broadcast(projectId, "session_completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emit(sessionId, { type: "stderr", sessionId, data: `${message}\n` });
      if (resetNeeded) {
        try {
          await execGit(["bisect", "reset"], resetWorkingDir ?? process.cwd());
        } catch { /* ignore */ }
      }
      await finishSession(workspaceId, sessionId, 1, {
        status: "failed",
        breakingCommitSha: null,
        message,
        diffStat: null,
        failingTestName: null,
        skippedCommits: [],
        testedCommits: [],
        scope,
        changedFiles: [],
      });
      if (projectId) boardEvents?.broadcast(projectId, "session_completed");
    }
  }

  async function startBisect(workspaceId: string, scope: BisectScope): Promise<{ sessionId: string }> {
    const rows = await database
      .select({ workspace: workspaces, projectId: issues.projectId })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!row.workspace.workingDir) throw new WorkspaceError("Workspace has no working directory", "BAD_REQUEST");

    const existingSessions = await database
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));
    if (existingSessions.some((s) => s.status === "running")) {
      throw new WorkspaceError("A session is already running for this workspace", "CONFLICT");
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await database.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor: "auto-bisect",
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      triggerType: "bisect",
    });
    await database.update(workspaces)
      .set({ status: "active", updatedAt: now })
      .where(eq(workspaces.id, workspaceId));

    if (row.projectId) boardEvents?.broadcast(row.projectId, "session_launched");
    void runBisect(workspaceId, sessionId, scope);
    return { sessionId };
  }

  return { startBisect, runBisect };
}

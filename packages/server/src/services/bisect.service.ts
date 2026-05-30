import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { issues, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import type { SessionManager } from "./session.manager.js";
import { WorkspaceError } from "./workspace-internals.js";

export type BisectScope = "related" | "full";

class BisectCancelled extends Error {
  constructor() {
    super("Auto-bisect stopped");
  }
}

interface ActiveBisect {
  cancelled: boolean;
  child: ChildProcessWithoutNullStreams | null;
}

const activeBisects = new Map<string, ActiveBisect>();

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

interface BisectTestCommand {
  command: string;
  args: string[];
  cwd: string;
  display: string;
}

function execGit(args: string[], cwd: string, allowedExitCodes = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout.toString()}${stderr.toString()}`;
      if (err) {
        const exitCode = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
        if (exitCode != null && allowedExitCodes.includes(exitCode)) {
          resolve(output);
          return;
        }
        reject(new Error(`git ${args.join(" ")} failed: ${output || err.message}`));
      } else {
        resolve(output);
      }
    });
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function trimOutput(output: string, max = 200_000): string {
  return output.length <= max ? output : output.slice(output.length - max);
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function relatedFilesForServerPackage(repoRoot: string, changedFiles: string[]): string[] {
  const serverDir = join(repoRoot, "packages", "server");
  return changedFiles
    .map(toPosixPath)
    .filter((file) => file.startsWith("packages/server/"))
    .map((file) => toPosixPath(relative(serverDir, join(repoRoot, file))))
    .filter(Boolean);
}

export function buildBisectTestCommand(repoRoot: string, scope: BisectScope, changedFiles: string[]): BisectTestCommand {
  const fullArgs = ["--filter", "agentic-kanban", "test", "--", "--reporter=verbose"];
  if (scope !== "related" || changedFiles.length === 0) {
    return {
      command: "pnpm",
      args: fullArgs,
      cwd: repoRoot,
      display: `pnpm ${fullArgs.join(" ")}`,
    };
  }

  const hasServerPackage = existsSync(join(repoRoot, "packages", "server", "package.json"));
  const hasWorkspace = existsSync(join(repoRoot, "pnpm-workspace.yaml"));
  if (hasServerPackage && hasWorkspace) {
    const relatedFiles = relatedFilesForServerPackage(repoRoot, changedFiles);
    if (relatedFiles.length > 0) {
      const args = ["--filter", "agentic-kanban", "exec", "vitest", "related", ...relatedFiles, "--reporter=verbose"];
      return {
        command: "pnpm",
        args,
        cwd: repoRoot,
        display: `pnpm ${args.join(" ")}`,
      };
    }
    return {
      command: "pnpm",
      args: fullArgs,
      cwd: repoRoot,
      display: `pnpm ${fullArgs.join(" ")}`,
    };
  }

  return {
    command: "pnpm",
    args: fullArgs,
    cwd: repoRoot,
    display: `pnpm ${fullArgs.join(" ")}`,
  };
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
    const match = line.match(/^(?:[x×✕]\s+|FAIL\s+)(.+)$/i);
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
  ].some((needle) => output.includes(needle));
}

function throwIfCancelled(active: ActiveBisect) {
  if (active.cancelled) throw new BisectCancelled();
}

function killProcessTree(child: ChildProcessWithoutNullStreams) {
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  child.kill();
}

export function stopBisectSession(sessionId: string): boolean {
  const active = activeBisects.get(sessionId);
  if (!active) return false;
  active.cancelled = true;
  if (active.child && !active.child.killed) {
    killProcessTree(active.child);
  }
  return true;
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

  async function runTests(sessionId: string, cwd: string, scope: BisectScope, changedFiles: string[], active: ActiveBisect) {
    const testCommand = buildBisectTestCommand(cwd, scope, changedFiles);
    await emitLine(sessionId, `$ ${testCommand.display}`);

    return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const command = process.platform === "win32" ? "cmd.exe" : testCommand.command;
      const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", testCommand.command, ...testCommand.args] : testCommand.args;
      const child = spawn(command, commandArgs, { cwd: testCommand.cwd, windowsHide: true, shell: false });
      active.child = child;
      let settled = false;
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
        if (settled) return;
        settled = true;
        active.child = null;
        const data = `${err.message}\n`;
        output = trimOutput(output + data);
        void emit(sessionId, { type: "stderr", sessionId, data });
        resolve({ exitCode: 127, output });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        active.child = null;
        resolve({ exitCode: code, output });
      });
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

  async function stopSession(workspaceId: string, sessionId: string) {
    const now = new Date().toISOString();
    await emitLine(sessionId, "Auto-bisect stopped.");
    await emit(sessionId, { type: "exit", sessionId, exitCode: 130 });
    await database.update(sessions)
      .set({ status: "stopped", endedAt: now, exitCode: "130" })
      .where(eq(sessions.id, sessionId));
    await database.update(workspaces)
      .set({ status: "idle", updatedAt: now })
      .where(eq(workspaces.id, workspaceId));
  }

  async function runBisect(workspaceId: string, sessionId: string, scope: BisectScope) {
    const active = activeBisects.get(sessionId) ?? { cancelled: false, child: null };
    activeBisects.set(sessionId, active);
    let resetNeeded = false;
    let resetWorkingDir: string | null = null;
    let projectId: string | null = null;
    let exitCode = 1;
    try {
      const rows = await database
        .select({
          workingDir: workspaces.workingDir,
          baseCommitSha: workspaces.baseCommitSha,
          projectId: issues.projectId,
        })
        .from(workspaces)
        .innerJoin(issues, eq(workspaces.issueId, issues.id))
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      const row = rows[0];
      if (!row) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
      projectId = row.projectId;
      if (!row.workingDir) throw new WorkspaceError("Workspace has no working directory", "BAD_REQUEST");
      if (!row.baseCommitSha) throw new WorkspaceError("Workspace has no base commit SHA to use as the good commit", "BAD_REQUEST");
      resetWorkingDir = row.workingDir;

      const dirty = (await execGit(["status", "--porcelain"], row.workingDir)).trim();
      if (dirty) throw new WorkspaceError("Working tree must be clean before auto-bisect can run", "CONFLICT");

      const badSha = (await execGit(["rev-parse", "HEAD"], row.workingDir)).trim();
      const goodSha = row.baseCommitSha;
      const changedFiles = (await execGit(["diff", "--name-only", `${goodSha}..${badSha}`], row.workingDir))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      throwIfCancelled(active);
      await emitLine(sessionId, `Auto-bisect starting: bad=${badSha} good=${goodSha} scope=${scope}`);
      if (scope === "related") {
        await emitLine(sessionId, changedFiles.length > 0
          ? `Related test scope files: ${changedFiles.join(", ")}`
          : "No changed files detected; falling back to full test suite.");
      }

      await execGit(["bisect", "start", badSha, goodSha], row.workingDir);
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
        throwIfCancelled(active);
        const current = (await execGit(["rev-parse", "HEAD"], row.workingDir)).trim();
        if (seen.has(current)) {
          await emitLine(sessionId, `Stopping: git bisect revisited ${current}.`);
          break;
        }
        seen.add(current);
        await emitLine(sessionId, `\n[${step}] Testing ${current}`);

        const test = await runTests(sessionId, row.workingDir, scope, changedFiles, active);
        throwIfCancelled(active);
        const output = trimOutput(test.output);
        if (test.exitCode === 0) {
          result.testedCommits.push({ sha: current, result: "good", exitCode: 0 });
          const markOutput = await execGit(["bisect", "good"], row.workingDir, [0, 10]);
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
          const markOutput = await execGit(["bisect", "skip"], row.workingDir, [0, 10]);
          await emitLine(sessionId, `Skipped ${shortSha(current)} because the test command could not run cleanly.`);
          if (markOutput.includes("only 'skip'ped commits left")) break;
          continue;
        }

        result.testedCommits.push({ sha: current, result: "bad", exitCode: test.exitCode });
        result.failingTestName ??= extractFailingTestName(output);
        const markOutput = await execGit(["bisect", "bad"], row.workingDir, [0, 10]);
        await emitLine(sessionId, `Marked ${shortSha(current)} bad.`);
        const firstBad = extractFirstBadCommit(markOutput);
        if (firstBad) {
          result.breakingCommitSha = firstBad;
          result.status = "found";
          break;
        }
      }

      if (result.breakingCommitSha) {
        result.message = (await execGit(["log", "-1", "--format=%s", result.breakingCommitSha], row.workingDir)).trim();
        result.diffStat = (await execGit(["show", "--stat", "--oneline", "--summary", "--no-renames", result.breakingCommitSha], row.workingDir)).trim();
        exitCode = 0;
      }

      if (resetNeeded) {
        await execGit(["bisect", "reset"], row.workingDir);
        resetNeeded = false;
      }
      await finishSession(workspaceId, sessionId, exitCode, result);
      if (projectId) boardEvents?.broadcast(projectId, "session_completed");
    } catch (err) {
      if (err instanceof BisectCancelled) {
        if (resetNeeded) {
          try {
            await execGit(["bisect", "reset"], resetWorkingDir ?? process.cwd());
          } catch { /* ignore */ }
        }
        await stopSession(workspaceId, sessionId);
        if (projectId) boardEvents?.broadcast(projectId, "session_stopped");
        return;
      }
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
    } finally {
      activeBisects.delete(sessionId);
    }
  }

  async function startBisect(workspaceId: string, scope: BisectScope): Promise<{ sessionId: string }> {
    const rows = await database
      .select({ workingDir: workspaces.workingDir, projectId: issues.projectId })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!row.workingDir) throw new WorkspaceError("Workspace has no working directory", "BAD_REQUEST");

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

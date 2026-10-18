import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getPreference, setPreference, deletePreferences } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { createMergeTrain, getMergeTrain, getIssueNumbersByWorkspaceIds, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { getMergeQueueWorkspaceRows } from "../repositories/merge-queue.repository.js";
import { holdTrainWindow, readTrainWindow } from "./merge-train-window-state.js";
import { finalizeMergeCleanup } from "./merge-cleanup.service.js";
import type { LandLocalDeps } from "./train-land-local.service.js";

const TAIL_LINES = 80;

/** Run a shell command in `cwd`, streaming output to the operator while keeping the tail. */
function runStreaming(command: string, cwd: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; tail: string }>((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, ...env } });
    const lines: string[] = [];
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      lines.push(...text.split(/\r?\n/));
      if (lines.length > TAIL_LINES * 2) lines.splice(0, lines.length - TAIL_LINES);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => resolve({ code: null, tail: String(err) }));
    child.on("close", (code) => resolve({ code, tail: lines.slice(-TAIL_LINES).join("\n") }));
  });
}

/** The real wiring for `landTrainLocal`: board database, git via the one git adapter, pnpm via the shell. */
export function createLandLocalDeps(database: Database = db): LandLocalDeps {
  return {
    log: (message) => console.log(`[land-local] ${message}`),
    async getTrain(trainId) {
      const row = await getMergeTrain(trainId, database);
      if (!row) return null;
      let gateEvidence: Record<string, unknown> | null = null;
      try {
        gateEvidence = row.gateEvidence ? (JSON.parse(row.gateEvidence) as Record<string, unknown>) : null;
      } catch { /* unreadable evidence: treat as none */ }
      return { id: row.id, projectId: row.projectId, label: row.label, state: row.state, memberWorkspaceIds: JSON.parse(row.memberWorkspaceIds) as string[], gateEvidence };
    },
    async getWindowMemberIds(projectId) {
      return (await readTrainWindow(projectId, database))?.pendingIds ?? [];
    },
    async loadMembers(workspaceIds) {
      const rows = await getMergeQueueWorkspaceRows(workspaceIds, database);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const numbers = await getIssueNumbersByWorkspaceIds(workspaceIds, database);
      return workspaceIds.flatMap((id) => {
        const w = byId.get(id);
        return w ? [{ workspaceId: id, issueId: w.issueId, issueNumber: numbers.get(id) ?? null, branch: w.branch }] : [];
      });
    },
    async getProject(projectId) {
      const p = await getProjectById(projectId, database);
      return p?.repoPath ? { repoPath: p.repoPath, defaultBranch: p.defaultBranch || "master" } : null;
    },
    async getTrainProjectId(trainId) {
      return (await getMergeTrain(trainId, database))?.projectId ?? null;
    },
    getPref: (key) => getPreference(key, database),
    setPref: (key, value) => setPreference(key, value, database),
    deletePref: (key) => deletePreferences([key], database),
    async holdWindow(projectId, minutes) {
      await holdTrainWindow(projectId, minutes, database);
    },
    async abandonTrain(trainId, reason) {
      await updateMergeTrainState(trainId, { state: "abandoned", reconciledReason: reason, finishedAt: new Date().toISOString() }, database);
    },
    createTrainRow: (row) => createMergeTrain({ ...row }, database),
    async markTrainLanded(trainId, evidence) {
      await updateMergeTrainState(trainId, { state: "landed", gateEvidence: evidence, finishedAt: new Date().toISOString() }, database);
    },
    async closeMember(member, projectId, mergedAt) {
      await finalizeMergeCleanup({ database, workspaceId: member.workspaceId, issueId: member.issueId, projectId, mergedAt, now: mergedAt });
    },
    async git(args, cwd) {
      const r = await gitExec(args, { cwd });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    },
    run: runStreaming,
    pathExists: existsSync,
    newId: () => randomUUID(),
    nowIso: () => new Date().toISOString(),
  };
}

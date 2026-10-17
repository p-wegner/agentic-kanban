import { basename, dirname, join } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { buildMergeTrainCommitMessage } from "./merge-train.service.js";
import { trainRefName } from "./merge-train-assembly.js";

/**
 * Operator "land this train locally" (#1586): the manual recipe from the 2026-10-17 train-04
 * landing as ONE orchestration - pause auto-merge and hold the window, assemble (or reuse the
 * train ref) in a sibling `.worktrees/` checkout, install, run the gate there, then merge with
 * the standard `Merge train <label>: #A #B` subject and close the members through
 * `finalizeMergeCleanup` (the normal landing bookkeeping, not the hand-merged reconciler).
 *
 * Everything with a side effect is behind `LandLocalDeps` so the flow is testable without git,
 * pnpm or a database; `train-land-local-deps.ts` holds the real wiring.
 */

export const LAND_LOCAL_HOLD_MINUTES = 12 * 60;

/** The project gate, in order. `test:mine` is file-scoped to the train diff via `KANBAN_TEST_FILES`. */
export const LAND_LOCAL_GATE_STEPS: ReadonlyArray<{ name: string; command: string }> = [
  { name: "check:arch", command: "pnpm check:arch" },
  { name: "typecheck", command: "pnpm typecheck" },
  { name: "test:mine", command: "pnpm test:mine" },
];

export interface LandLocalMember {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  branch: string;
}

export interface LandLocalTrainRow {
  id: string;
  projectId: string;
  label: string;
  state: string;
  memberWorkspaceIds: string[];
}

export interface LandLocalRunResult {
  code: number | null;
  /** Last lines of combined output, for the failing-suite report. */
  tail: string;
}

export interface LandLocalDeps {
  log(message: string): void;
  getTrain(trainId: string): Promise<LandLocalTrainRow | null>;
  /** `--from-window`: the project's pending train-window members. */
  getWindowMemberIds(projectId: string): Promise<string[]>;
  loadMembers(workspaceIds: string[]): Promise<LandLocalMember[]>;
  getTrainProjectId(trainId: string): Promise<string | null>;
  getProject(projectId: string): Promise<{ repoPath: string; defaultBranch: string } | null>;
  getPref(key: string): Promise<string | null>;
  setPref(key: string, value: string): Promise<void>;
  deletePref(key: string): Promise<void>;
  holdWindow(projectId: string, minutes: number): Promise<void>;
  /** Mark an assembling/gating row abandoned (the board's own job is not in this process). */
  abandonTrain(trainId: string, reason: string): Promise<void>;
  createTrainRow(row: { id: string; projectId: string; label: string; memberWorkspaceIds: string[] }): Promise<void>;
  markTrainLanded(trainId: string, evidence: Record<string, unknown>): Promise<void>;
  closeMember(member: LandLocalMember, projectId: string, mergedAt: string): Promise<void>;
  git(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
  run(command: string, cwd: string, env: Record<string, string>): Promise<LandLocalRunResult>;
  pathExists(path: string): boolean;
  newId(): string;
  nowIso(): string;
}

export interface LandLocalInput {
  projectId: string;
  /** A train row id; absent with `fromWindow`. */
  trainId?: string;
  fromWindow?: boolean;
  /** Re-run the gate in the worktree a previous red run left behind. */
  continueRun?: boolean;
  skipInstall?: boolean;
  /** Override the gate step list (tests, or a project with a different gate). */
  gateSteps?: ReadonlyArray<{ name: string; command: string }>;
}

export type LandLocalOutcome =
  | { status: "landed"; mergeSha: string; trainId: string; label: string; closed: number[] }
  | { status: "red"; step: string; failedSuites: string[]; worktree: string; tail: string }
  | { status: "conflict"; branch: string; worktree: string }
  | { status: "error"; message: string; worktree?: string };

/** `<repo parent>/.worktrees/<repo name>/land-local/<label>` - the sibling layout the board uses. */
export function landLocalWorktreePath(repoPath: string, label: string): string {
  const safe = label.replace(/^train\//, "").replace(/[^A-Za-z0-9._-]/g, "-");
  return join(dirname(repoPath), ".worktrees", basename(repoPath), "land-local", safe);
}

export function landLocalBranchName(label: string): string {
  return `kanban/land-local/${label.replace(/^train\//, "").replace(/[^A-Za-z0-9._/-]/g, "-")}`;
}

/** Failing suite files named in vitest-style output (`FAIL  path/to/x.test.ts > ...`). */
export function parseFailedSuites(output: string): string[] {
  const found = new Set<string>();
  for (const m of output.matchAll(/(?:FAIL|❯)\s+(?:\S+\s+)?([\w@./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?)/g)) {
    found.add(m[1].replace(/\\/g, "/"));
  }
  return [...found];
}

function windowLabel(now: string): string {
  return `local-${now.slice(0, 16).replace(/[-:T]/g, "")}`;
}

export async function landTrainLocal(input: LandLocalInput, deps: LandLocalDeps): Promise<LandLocalOutcome> {
  const { projectId } = input;
  const project = await deps.getProject(projectId);
  if (!project) return { status: "error", message: `project ${projectId} not found` };
  const repo = project.repoPath;
  const base = project.defaultBranch;

  // Resolve the target before touching any state, so a typo pauses nothing.
  let train: LandLocalTrainRow | null = null;
  let memberIds: string[];
  let label: string;
  if (input.trainId) {
    train = await deps.getTrain(input.trainId);
    if (!train) return { status: "error", message: `train ${input.trainId} not found` };
    if (train.projectId !== projectId) return { status: "error", message: `train ${train.id} belongs to another project` };
    if (train.state === "landed") return { status: "error", message: `train ${train.id} already landed` };
    memberIds = train.memberWorkspaceIds;
    label = train.label;
  } else if (input.fromWindow) {
    memberIds = await deps.getWindowMemberIds(projectId);
    if (memberIds.length === 0) return { status: "error", message: "no open merge-train window with pending members" };
    label = windowLabel(deps.nowIso());
  } else {
    return { status: "error", message: "give a train id or --from-window" };
  }
  const members = await deps.loadMembers(memberIds);
  if (members.length === 0) return { status: "error", message: "the train has no loadable members" };

  const worktree = landLocalWorktreePath(repo, label);
  const branch = landLocalBranchName(label);
  const worktreeExists = deps.pathExists(worktree);
  if (input.continueRun && !worktreeExists) {
    return { status: "error", message: `--continue: no worktree at ${worktree}` };
  }
  if (!input.continueRun && worktreeExists) {
    return { status: "error", message: `worktree ${worktree} already exists from an earlier run - fix it and re-run with --continue`, worktree };
  }

  // 1. Pause auto-merge + hold the window. Restored in `finally`, red or thrown.
  const autoMergeKey = `auto_merge_disabled_${projectId}`;
  const priorAutoMerge = await deps.getPref(autoMergeKey);
  await deps.setPref(autoMergeKey, "true");
  await deps.holdWindow(projectId, LAND_LOCAL_HOLD_MINUTES);
  deps.log(`paused auto-merge and held the train window for project ${projectId}`);
  try {
    if (train && (train.state === "assembling" || train.state === "gating")) {
      await deps.abandonTrain(train.id, "cancelled: landing locally (train land-local)");
      deps.log(`train ${train.id} (${train.label}) cancelled on the board`);
    }

    // 2. Worktree: reuse the train ref, else assemble the members onto the base.
    if (!input.continueRun) {
      const assembled = await assemble({ deps, repo, base, label, branch, worktree, members });
      if (assembled) return assembled;
    }

    const installOutcome = input.skipInstall || input.continueRun ? null : await step(deps, "install", "pnpm install -r", worktree, {});
    if (installOutcome && installOutcome.code !== 0) {
      return { status: "red", step: "install", failedSuites: [], worktree, tail: installOutcome.tail };
    }

    // 3. Gate, scoped to the train diff.
    const diff = await deps.git(["diff", "--name-only", `${base}...HEAD`], worktree);
    const changed = diff.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const gate of input.gateSteps ?? LAND_LOCAL_GATE_STEPS) {
      const result = await step(deps, gate.name, gate.command, worktree, { KANBAN_TEST_FILES: changed.join(",") });
      if (result.code !== 0) {
        deps.log(`gate RED at ${gate.name}; worktree left at ${worktree} - commit a fix there, then re-run with --continue`);
        return { status: "red", step: gate.name, failedSuites: parseFailedSuites(result.tail), worktree, tail: result.tail };
      }
    }

    // 4. Land on the base in the main checkout, with the standard subject.
    return await land({ deps, projectId, repo, base, label, branch, worktree, members, train, changedCount: changed.length });
  } catch (err) {
    return { status: "error", message: errorMessage(err), worktree: deps.pathExists(worktree) ? worktree : undefined };
  } finally {
    await restore(deps, projectId, autoMergeKey, priorAutoMerge);
  }
}

async function step(deps: LandLocalDeps, name: string, command: string, cwd: string, env: Record<string, string>) {
  deps.log(`gate step: ${name} ...`);
  const started = Date.now();
  const result = await deps.run(command, cwd, env);
  deps.log(`gate step: ${name} ${result.code === 0 ? "passed" : `FAILED (exit ${result.code})`} in ${Math.round((Date.now() - started) / 1000)}s`);
  return result;
}

async function restore(deps: LandLocalDeps, projectId: string, key: string, prior: string | null): Promise<void> {
  try {
    if (prior === null) await deps.deletePref(key);
    else await deps.setPref(key, prior);
    await deps.holdWindow(projectId, 0);
    deps.log("restored auto-merge and cleared the window hold");
  } catch (err) {
    deps.log(`WARNING: could not restore auto-merge / window hold (${errorMessage(err)}) - reset ${key} and clear the hold by hand`);
  }
}

async function assemble(a: {
  deps: LandLocalDeps; repo: string; base: string; label: string; branch: string; worktree: string; members: LandLocalMember[];
}): Promise<LandLocalOutcome | null> {
  const { deps, repo, base, label, branch, worktree, members } = a;
  const ref = trainRefName(label);
  const hasRef = (await deps.git(["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], repo)).code === 0;
  const start = hasRef ? ref : base;
  const added = await deps.git(["worktree", "add", "-b", branch, worktree, start], repo);
  if (added.code !== 0) return { status: "error", message: `git worktree add failed: ${added.stderr.trim()}` };
  deps.log(hasRef ? `reusing train ref ${ref} in ${worktree}` : `assembling ${members.length} member(s) onto ${base} in ${worktree}`);
  if (hasRef) return null;
  for (const m of members) {
    const merged = await deps.git(["merge", "--no-ff", "-m", `Merge ${m.branch} (#${m.issueNumber ?? "?"}) into train`, m.branch], worktree);
    if (merged.code !== 0) {
      await deps.git(["merge", "--abort"], worktree);
      deps.log(`member ${m.branch} conflicts with the earlier members; worktree left at ${worktree}`);
      return { status: "conflict", branch: m.branch, worktree };
    }
  }
  return null;
}

async function land(a: {
  deps: LandLocalDeps; projectId: string; repo: string; base: string; label: string; branch: string;
  worktree: string; members: LandLocalMember[]; train: LandLocalTrainRow | null; changedCount: number;
}): Promise<LandLocalOutcome> {
  const { deps, projectId, repo, base, label, branch, worktree, members, train } = a;
  const current = (await deps.git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout.trim();
  if (current !== base) return { status: "error", message: `main checkout is on ${current}, not ${base}`, worktree };
  const dirty = (await deps.git(["status", "--porcelain", "--untracked-files=no"], repo)).stdout.trim();
  if (dirty) return { status: "error", message: "main checkout has uncommitted changes", worktree };
  // The gate ran on a tree that must contain today's base, or we would land an unverified merge.
  if ((await deps.git(["merge-base", "--is-ancestor", base, branch], repo)).code !== 0) {
    return { status: "error", message: `${base} moved since the worktree was cut; merge ${base} into ${branch} there and re-run with --continue`, worktree };
  }

  const trainId = train?.id ?? deps.newId();
  if (!train) await deps.createTrainRow({ id: trainId, projectId, label, memberWorkspaceIds: members.map((m) => m.workspaceId) });
  const trainSha = (await deps.git(["rev-parse", branch], repo)).stdout.trim();
  const baseSha = (await deps.git(["rev-parse", base], repo)).stdout.trim();
  const message = buildMergeTrainCommitMessage({
    parentLabel: label,
    included: members.map((m) => ({ workspaceId: m.workspaceId, branch: m.branch, issueNumber: m.issueNumber })),
    evidence: { trainId, trainSha, baseSha, gateRuns: 1, gateMessage: `landed locally by operator (train land-local), ${a.changedCount} changed file(s) scoped` },
  });
  const merged = await deps.git(["merge", "--no-ff", "-m", message, branch], repo);
  if (merged.code !== 0) {
    await deps.git(["merge", "--abort"], repo);
    return { status: "error", message: `merge into ${base} failed: ${merged.stderr.trim() || merged.stdout.trim()}`, worktree };
  }
  const mergeSha = (await deps.git(["rev-parse", "HEAD"], repo)).stdout.trim();
  deps.log(`landed ${mergeSha.slice(0, 12)} on ${base}`);

  // Normal landing bookkeeping, per member. One failing close must not strand the others.
  const now = deps.nowIso();
  const closed: number[] = [];
  for (const m of members) {
    try {
      await deps.closeMember(m, projectId, now);
      if (m.issueNumber != null) closed.push(m.issueNumber);
    } catch (err) {
      deps.log(`WARNING: could not close member #${m.issueNumber ?? m.workspaceId}: ${errorMessage(err)} (hand-merged-branch-reconciler will pick it up)`);
    }
  }
  await deps.markTrainLanded(trainId, {
    gateRuns: 1,
    landed: members.map((m) => m.workspaceId),
    dropped: [],
    unresolved: [],
    mergeSha,
    landedLocally: true,
  });

  // 5. Clean up.
  await deps.git(["worktree", "remove", "--force", worktree], repo);
  await deps.git(["branch", "-D", branch], repo);
  deps.log(`worktree ${worktree} removed; reinstall in the main checkout if dependencies changed (pnpm install -r)`);
  return { status: "landed", mergeSha, trainId, label, closed };
}

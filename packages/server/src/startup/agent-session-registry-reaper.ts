import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { isPidAlive } from "../lib/pid.js";
import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

/**
 * Delete the session-registry files left behind by agents this board KILLED (#708).
 *
 * Claude Code writes `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` when a session starts and
 * removes it on a clean exit. The board ends an agent by PID (`killPid` in
 * `services/agent.service.ts` — `taskkill /T /F` on Windows, SIGTERM elsewhere), and a
 * killed process never runs its own cleanup, so the file survives forever. Measured
 * 2026-08-21: 48 orphans across the profile dirs, 39 in one of them, every single one
 * `entrypoint: "sdk-cli"` with a cwd under `.worktrees/agentic-kanban/ak-*` — i.e.
 * board-spawned.
 *
 * **The cost is not disk, it is a wrong answer about liveness.** A registry file names a
 * PID. When the OS hands that PID to something else, every tool that reads the registry
 * sees a live session that does not exist — and PIDs recycle fast on this machine, where
 * vitest workers spawn and die by the hundred. One collision was already present in the
 * 48-file sample (a PID belonging to an unrelated `powershell.exe`). Inflated session
 * counts are the visible symptom; the invisible one is a supervisor deciding not to start
 * work because it thinks an agent is already running.
 *
 * Fixing this at the kill site would have been narrower, and wrong: the board is not the
 * only way one of these is orphaned (a crash, a `killAll`, a hard reboot, a `SIGKILL` of
 * the board itself all leave the same file), and a kill-site cleanup cannot remove the
 * ones that already exist. A periodic sweep is crash-safe by construction, which is the
 * whole reason this repo has the kind.
 */

/** Delay before a dead PID's file is reaped, so a just-spawned session is never a candidate. */
const MIN_ORPHAN_AGE_MS = 60_000;

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/** `<pid>.json` — the only filename shape this sweep will ever delete. */
const REGISTRY_FILE = /^(\d+)\.json$/;

export interface RegistryFs {
  exists(path: string): boolean;
  listDirs(path: string): string[];
  listFiles(path: string): string[];
  mtimeMs(path: string): number;
  remove(path: string): void;
}

export interface AgentSessionRegistryReaperDeps {
  /** Config dirs to sweep. Defaults to every `~/.claude*` dir plus `$CLAUDE_CONFIG_DIR`. */
  configDirs?: string[];
  /** Liveness probe, injected by tests. */
  pidAlive?: (pid: number) => boolean;
  /** Epoch ms, for age comparisons (#614: `nowMs` is the canonical spelling for arithmetic). */
  nowMs?: number;
  /** Filesystem seam, so the suite never touches a real home directory. */
  fs?: RegistryFs;
  log?: (message: string) => void;
  onTick?: () => void;
}

export const nodeRegistryFs: RegistryFs = {
  exists: (path) => existsSync(path),
  listDirs: (path) =>
    readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  listFiles: (path) =>
    readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name),
  mtimeMs: (path) => statSync(path).mtimeMs,
  remove: (path) => unlinkSync(path),
};

export interface AgentSessionRegistryReapResult extends PassReport {
  /** Absolute paths of the files removed, so a caller can report WHAT went. */
  removed: string[];
  /** Config dirs that actually had a `sessions/` directory to look at. */
  dirsScanned: string[];
}

export type RegistryFileVerdict =
  | { action: "remove"; reason: "dead-pid" }
  | { action: "keep"; reason: "not-a-registry-file" | "pid-alive" | "too-recent" };

/**
 * Should this file go? Pure, and separate from the sweep on purpose (the **decision
 * function** kind): every interesting case here is a cheap table row, while the sweep
 * around it needs a home directory full of real files.
 *
 * The three `keep` reasons are each load-bearing:
 *  - `not-a-registry-file` — this sweep DELETES things in the user's home directory, so
 *    the filename shape is a hard gate, not a filter. Anything that is not exactly
 *    `<digits>.json` is left alone whatever else is true of it.
 *  - `pid-alive` — the file describes a running session. Note this is also what protects
 *    the recycled-PID case in the safe direction: a stale file whose PID now belongs to an
 *    unrelated process reads as alive and SURVIVES. That is deliberate — it is the wrong
 *    answer this ticket is about, but deleting a file that might describe a live session is
 *    a worse one, and the file goes as soon as that process exits.
 *  - `too-recent` — closes the spawn-time window where a PID could read dead before the
 *    session it belongs to has properly begun.
 */
export function decideRegistryFile(input: {
  fileName: string;
  pidAlive: boolean;
  ageMs: number;
}): RegistryFileVerdict {
  if (!REGISTRY_FILE.test(input.fileName)) return { action: "keep", reason: "not-a-registry-file" };
  if (input.pidAlive) return { action: "keep", reason: "pid-alive" };
  if (input.ageMs < MIN_ORPHAN_AGE_MS) return { action: "keep", reason: "too-recent" };
  return { action: "remove", reason: "dead-pid" };
}

/**
 * Every Claude config dir on this machine: `~/.claude` and each `~/.claude-<profile>`
 * sibling (which is what an OAuth profile IS — see `claude-subscription-ring.ts`), plus an
 * explicit `$CLAUDE_CONFIG_DIR` if it points somewhere else.
 *
 * Deliberately discovered from disk rather than from the rotation ring or the prefs: the
 * orphans accumulate in whatever dir the agent ran under, including profiles that have
 * since been removed from the ring, and a dir the board no longer launches into is exactly
 * the one nobody will clean up by hand.
 */
export function discoverClaudeConfigDirs(fs: RegistryFs = nodeRegistryFs, home = homedir()): string[] {
  const dirs = new Set<string>();
  try {
    for (const name of fs.listDirs(home)) {
      if (name === ".claude" || name.startsWith(".claude-")) dirs.add(join(home, name));
    }
  } catch {
    // No readable home is not this sweep's problem to report.
  }
  const explicit = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (explicit) dirs.add(explicit);
  return [...dirs];
}

export async function reapAgentSessionRegistry(
  deps: AgentSessionRegistryReaperDeps = {},
): Promise<AgentSessionRegistryReapResult> {
  const fs = deps.fs ?? nodeRegistryFs;
  const pidAlive = deps.pidAlive ?? isPidAlive;
  const nowMs = deps.nowMs ?? Date.now();
  const log = deps.log ?? ((message: string) => console.log(`[session-registry-reaper] ${message}`));
  const configDirs = deps.configDirs ?? discoverClaudeConfigDirs(fs);

  const result: AgentSessionRegistryReapResult = {
    ...emptyPassReport(0),
    removed: [],
    dirsScanned: [],
  };

  for (const configDir of configDirs) {
    const sessionsDir = join(configDir, "sessions");
    if (!fs.exists(sessionsDir)) continue;

    let fileNames: string[];
    try {
      fileNames = fs.listFiles(sessionsDir);
    } catch (err) {
      log(`could not read ${sessionsDir}: ${errorMessage(err)}`);
      continue;
    }
    result.dirsScanned.push(sessionsDir);

    for (const fileName of fileNames) {
      result.scanned++;
      const path = join(sessionsDir, fileName);
      try {
        const match = REGISTRY_FILE.exec(fileName);
        // `pidAlive` is not consulted for a non-registry file: probing a PID we never
        // parsed would mean inventing one.
        const verdict = decideRegistryFile({
          fileName,
          pidAlive: match ? pidAlive(Number(match[1])) : false,
          ageMs: match ? nowMs - fs.mtimeMs(path) : 0,
        });
        if (verdict.action === "keep") {
          recordSkipped(result, path, verdict.reason);
          continue;
        }
        fs.remove(path);
        result.removed.push(path);
        recordActed(result, path, verdict.reason);
      } catch (err) {
        // Neither acted nor skipped — it lands in the unaccounted remainder, which is the
        // point of `PassReport` (#592): a pass that swallowed failures must not read clean.
        log(`failed to reap ${path}: ${errorMessage(err)}`);
      }
    }
  }

  if (result.scanned > 0) log(formatPassReportBody(result));
  return result;
}

let activeSweep: PeriodicSweepHandle | null = null;

export function stopAgentSessionRegistryReaper(): void {
  activeSweep?.stop();
  activeSweep = null;
}

export function startAgentSessionRegistryReaper(
  deps: AgentSessionRegistryReaperDeps = {},
  intervalMs = DEFAULT_INTERVAL_MS,
): PeriodicSweepHandle {
  stopAgentSessionRegistryReaper();
  activeSweep = startPeriodicSweep({
    name: "session-registry-reaper",
    tick: deps.onTick ?? (() => reapAgentSessionRegistry(deps)),
    bootDelayMs: 60_000,
    intervalMs,
  });
  return activeSweep;
}

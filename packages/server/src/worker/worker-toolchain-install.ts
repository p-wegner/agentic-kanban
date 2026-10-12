// The worker half of install-on-request (#1371). The board sends `toolchain_install`; THIS file decides
// whether anything runs, from the owner's own `--toolchain-install=never|ask|auto` (+ `--toolchain-allow`)
// policy, and installs through mise into a worker-owned data dir, never machine-global. Installing is code
// execution on this machine, so the board's request is only ever a request: `ask` waits for
// `agentic-kanban-worker toolchain approve <id>` (a file the CLI writes, polled here), `auto` only runs
// allowlisted toolchains. No mise = no install and no fallback to winget/apt.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  decideToolchainInstall,
  miseSpecFor,
  parseInstallRequirements,
  type ToolchainInstallPolicy,
  type ToolchainInstallStatus,
  type WorkerToolchainInstallInfo,
} from "@agentic-kanban/shared/lib/worker-toolchain-install";
import { missingToolchains, type WorkerToolchains } from "@agentic-kanban/shared/lib/worker-toolchains";
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

/** Runs one command; resolves the exit code and combined output, never rejects. `code: null` = could not spawn. */
export type RunFn = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; output: string }>;

export const runCommand: RunFn = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { env, timeout: 30 * 60_000, windowsHide: true, shell: process.platform === "win32", maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
        resolve({ code, output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });

/** One request awaiting the owner's approval, as the daemon and `toolchain list` both see it. */
export interface PendingToolchainRequest {
  id: string;
  toolchains: string[];
  requestedAt: string;
}

/** Where the worker keeps its mise data + the pending/approved request files, next to its state file. */
export function toolchainDirs(stateFile: string): { root: string; miseData: string; miseConfig: string; pending: string; approved: string } {
  const root = join(dirname(stateFile), "toolchains");
  return {
    root,
    miseData: join(root, "mise-data"),
    miseConfig: join(root, "mise-config"),
    pending: join(root, "pending.json"),
    approved: join(root, "approved.json"),
  };
}

function readJsonArray<T>(file: string): T[] {
  try {
    if (!existsSync(file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function readPendingRequests(stateFile: string): PendingToolchainRequest[] {
  return readJsonArray<PendingToolchainRequest>(toolchainDirs(stateFile).pending);
}

/** `toolchain approve <id>`: record the owner's approval. False when no such request is pending. */
export function approveToolchainRequest(stateFile: string, id: string): boolean {
  const dirs = toolchainDirs(stateFile);
  const pending = readPendingRequests(stateFile);
  const match = pending.find((p) => p.id === id || p.id.startsWith(id));
  if (!match) return false;
  mkdirSync(dirs.root, { recursive: true });
  const approved = readJsonArray<string>(dirs.approved);
  if (!approved.includes(match.id)) approved.push(match.id);
  writeFileSync(dirs.approved, JSON.stringify(approved));
  return true;
}

export interface ToolchainInstallerOptions {
  policy: ToolchainInstallPolicy;
  allow: string[];
  stateFile: string;
  sendToBoard: (message: WorkerToBoardMessage) => void;
  log: (line: string) => void;
  /** Re-detect toolchains (and refresh the cache the heartbeat reads); resolves the fresh reading. */
  redetect: () => Promise<WorkerToolchains | undefined>;
  /** Push a heartbeat so the board sees the new toolchains right away. */
  heartbeat?: () => Promise<void>;
  run?: RunFn;
  /** Env the install runs under (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface ToolchainInstaller {
  /** What this worker declares in its capabilities. */
  info(): WorkerToolchainInstallInfo;
  handleRequest(requestId: string, toolchains: string[]): Promise<void>;
  /** Run every request the owner approved since the last poll. */
  pollApprovals(): Promise<void>;
  /** On daemon start: put shims of an earlier install back on PATH. */
  activate(): void;
  /** Is mise runnable? Refreshes the cached answer `info()` reports. */
  refreshMise(): Promise<boolean>;
}

export function createToolchainInstaller(opts: ToolchainInstallerOptions): ToolchainInstaller {
  const run = opts.run ?? runCommand;
  const dirs = toolchainDirs(opts.stateFile);
  const baseEnv = opts.env ?? process.env;
  let miseAvailable = false;
  const inFlight = new Set<string>();

  const report = (status: ToolchainInstallStatus): void => opts.sendToBoard({ type: "toolchain_install_status", status });
  const miseEnv = (): NodeJS.ProcessEnv => ({ ...baseEnv, MISE_DATA_DIR: dirs.miseData, MISE_CONFIG_DIR: dirs.miseConfig });

  async function refreshMise(): Promise<boolean> {
    miseAvailable = (await run("mise", ["--version"], baseEnv)).code === 0;
    return miseAvailable;
  }

  function writePending(list: PendingToolchainRequest[]): void {
    mkdirSync(dirs.root, { recursive: true });
    writeFileSync(dirs.pending, JSON.stringify(list, null, 2));
  }

  /** The shims dir is what puts installed tools on PATH for this daemon AND the agents it spawns. */
  function activate(): void {
    const shims = join(dirs.miseData, "shims");
    const path = process.env.PATH ?? "";
    if (!path.split(delimiter).includes(shims)) process.env.PATH = `${shims}${delimiter}${path}`;
    process.env.MISE_DATA_DIR = dirs.miseData;
    process.env.MISE_CONFIG_DIR = dirs.miseConfig;
  }

  async function install(requestId: string, toolchains: string[]): Promise<void> {
    const reqs = parseInstallRequirements(toolchains);
    const specs = reqs.map(miseSpecFor).filter((s): s is string => s !== null);
    report({ requestId, state: "installing", toolchains });
    opts.log(`[worker] toolchain install ${requestId}: mise use -g ${specs.join(" ")}`);
    mkdirSync(dirs.miseData, { recursive: true });
    mkdirSync(dirs.miseConfig, { recursive: true });
    const res = await run("mise", ["use", "-g", ...specs], miseEnv());
    if (res.code !== 0) {
      const reason = `mise exited ${res.code ?? "without a code"}: ${res.output.split("\n").slice(-3).join(" ").slice(0, 300)}`;
      opts.log(`[worker] toolchain install ${requestId} failed: ${reason}`);
      report({ requestId, state: "failed", toolchains, reason });
      return;
    }
    activate();
    const have = await opts.redetect();
    const still = missingToolchains(reqs, have);
    if (still.length > 0) {
      const reason = `installed through mise but ${still.join(", ")} still not detected on PATH`;
      opts.log(`[worker] toolchain install ${requestId} failed: ${reason}`);
      report({ requestId, state: "failed", toolchains, reason });
    } else {
      opts.log(`[worker] toolchain install ${requestId} done: ${toolchains.join(", ")}`);
      report({ requestId, state: "done", toolchains });
    }
    await opts.heartbeat?.().catch(() => undefined);
  }

  return {
    refreshMise,
    activate: () => { if (existsSync(join(dirs.miseData, "shims"))) activate(); },
    info: () => ({ policy: opts.policy, allow: opts.allow, mise: miseAvailable }),

    async handleRequest(requestId, toolchains) {
      if (inFlight.has(requestId)) return;
      await refreshMise();
      const decision = decideToolchainInstall(this.info(), parseInstallRequirements(toolchains));
      if (decision.action === "blocked") {
        opts.log(`[worker] toolchain install ${requestId} refused: ${decision.reason}`);
        report({ requestId, state: "failed", toolchains, reason: decision.reason });
        return;
      }
      if (decision.action === "await-approval") {
        const pending = readPendingRequests(opts.stateFile);
        if (!pending.some((p) => p.id === requestId)) {
          writePending([...pending, { id: requestId, toolchains, requestedAt: new Date().toISOString() }]);
          opts.log(`[worker] the board asks to install ${toolchains.join(", ")} via mise. Approve with: agentic-kanban-worker toolchain approve ${requestId}`);
        }
        report({ requestId, state: "pending", toolchains, reason: `waiting for the worker owner: toolchain approve ${requestId}` });
        return;
      }
      inFlight.add(requestId);
      try { await install(requestId, toolchains); } finally { inFlight.delete(requestId); }
    },

    async pollApprovals() {
      const approved = readJsonArray<string>(dirs.approved);
      if (approved.length === 0) return;
      const pending = readPendingRequests(opts.stateFile);
      const ready = pending.filter((p) => approved.includes(p.id) && !inFlight.has(p.id));
      if (ready.length === 0) return;
      writePending(pending.filter((p) => !ready.includes(p)));
      writeFileSync(dirs.approved, JSON.stringify(approved.filter((id) => !ready.some((p) => p.id === id))));
      for (const req of ready) {
        inFlight.add(req.id);
        try {
          await refreshMise();
          if (!miseAvailable) report({ requestId: req.id, state: "failed", toolchains: req.toolchains, reason: "mise is not installed on the worker" });
          else await install(req.id, req.toolchains);
        } finally {
          inFlight.delete(req.id);
        }
      }
    },
  };
}

/** What the daemon needs from a toolchain installer: capabilities, frame handling, approval polling. */
export interface DaemonToolchainInstall {
  installer: ToolchainInstaller;
  /** Takes a `toolchain_install` frame; true when the message was one (and is consumed). */
  handle(message: { type: string; requestId?: string; toolchains?: string[] }): boolean;
  /** Start polling for `toolchain approve`; returns the stop function. */
  startPolling(): () => void;
}

export function createDaemonToolchainInstall(opts: ToolchainInstallerOptions): DaemonToolchainInstall {
  const installer = createToolchainInstaller(opts);
  installer.activate(); // shims of an earlier mise install go back on PATH BEFORE the first toolchain probe
  return {
    installer,
    handle(message) {
      if (message.type !== "toolchain_install" || !message.requestId || !message.toolchains) return false;
      void installer.handleRequest(message.requestId, message.toolchains).catch((err) =>
        opts.log(`[worker] toolchain install ${message.requestId} errored: ${err instanceof Error ? err.message : String(err)}`));
      return true;
    },
    startPolling() {
      const timer = setInterval(() => { void installer.pollApprovals().catch(() => undefined); }, 5_000);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

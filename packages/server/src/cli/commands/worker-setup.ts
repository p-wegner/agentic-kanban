/**
 * `agentic-kanban-worker setup` (#1368): turn a machine with only node into a paired worker, one
 * detecting, skippable step at a time: git -> provider CLIs -> harness dir + auth -> pair -> doctor.
 * Every step says `ok (already present)` / `done` / `skipped`, so re-running is idempotent.
 * Nothing is installed without a prompt (or --yes) and `--no-install` never runs an installer.
 * Db-free: this is part of the standalone worker binary.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { readOAuthCredentials } from "../../lib/oauth-quota-core.js";
import { defaultWorkerStateFile, type WorkerDaemonOptions } from "../../worker/worker-daemon.js";
import { pairWorker } from "../../worker/worker-pair.js";
import { createWorkerHarness, type WorkerHarness } from "../../worker/worker-harness.js";
import { cliPathArg } from "../cli-path.js";
import { AUTH_PROVIDERS, runWorkerAuth, type AuthProvider, type WorkerAuthOptions } from "./worker-auth-command.js";
import {
  probeCommand,
  readSavedIdentity,
  runWorkerDoctor,
  type DoctorReport,
  type WorkerDoctorOptions,
} from "./worker-doctor.js";
import {
  gitInstallPlan,
  gitIsNewEnough,
  providerInstallPlan,
  type InstallPlan,
  type NpmPrefixInfo,
  type SetupOs,
} from "./worker-setup-installers.js";
import { renderWorkerSetupGuide } from "./worker-setup-guide.js";

export const SETUP_STEPS = ["git", "cli", "auth", "pair", "doctor"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
type Outcome = "ok" | "ok (already present)" | "done" | "skipped" | "FAILED";

export interface SetupOptions {
  board?: string;
  token?: string;
  providers?: string;
  steps?: string;
  /** commander's `--no-install` negation: false when the flag was passed. */
  install?: boolean;
  yes?: boolean;
  configDir?: string;
  start?: boolean;
  guide?: boolean;
  stateFile?: string;
  name?: string;
}

export interface SetupDeps {
  os: SetupOs;
  isRoot: boolean;
  home: string;
  probe: (command: string, args: string[]) => Promise<{ found: boolean; output: string }>;
  /** Run an installer attached to the terminal; returns its exit status. */
  run: (plan: InstallPlan) => number;
  confirm: (question: string) => Promise<boolean>;
  print: (line: string) => void;
  npmPrefix: () => NpmPrefixInfo | null;
  pair: (opts: WorkerDaemonOptions) => Promise<{ alreadyPaired: boolean; name: string }>;
  auth: (provider: AuthProvider, opts: WorkerAuthOptions) => Promise<number>;
  doctor: (opts: WorkerDoctorOptions) => Promise<DoctorReport>;
  /** `--start`: keep running as the daemon once paired. */
  start?: () => Promise<void>;
  nowMs?: number;
}

const DEFAULT_BOARD_URL = "http://127.0.0.1:3001";

function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(`${question} (no terminal to ask on - re-run with --yes to accept)`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function readNpmPrefix(): NpmPrefixInfo | null {
  const res = spawnSync("npm", ["prefix", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const prefix = res.status === 0 ? String(res.stdout ?? "").trim() : "";
  if (!prefix) return null;
  try {
    accessSync(prefix, constants.W_OK);
    return { prefix, writable: true };
  } catch {
    return { prefix, writable: false };
  }
}

export function defaultSetupDeps(start?: () => Promise<void>): SetupDeps {
  const os = (["win32", "darwin"].includes(process.platform) ? process.platform : "linux") as SetupOs;
  return {
    os,
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    home: homedir(),
    probe: probeCommand,
    run: (plan) =>
      spawnSync(plan.command, plan.args, { stdio: "inherit", shell: plan.shell, windowsHide: true }).status ?? 1,
    confirm: askYesNo,
    print: (line) => console.log(line),
    npmPrefix: readNpmPrefix,
    pair: pairWorker,
    auth: (provider, opts) => runWorkerAuth(provider, opts),
    doctor: runWorkerDoctor,
    ...(start ? { start } : {}),
  };
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Is there a usable login for this provider in the worker's own config (a stored token counts)? */
export function hasCredential(harness: WorkerHarness, provider: AuthProvider, nowMs: number): boolean {
  const token = provider === "claude" ? harness.tokenStatus(provider, nowMs) : undefined;
  if (token?.stored && !token.expired) return true;
  const dir = harness.dirFor(provider);
  if (!dir) return false;
  if (provider === "claude") return readOAuthCredentials(dir, nowMs).err === undefined;
  return probeFile(join(dir, "auth.json"));
}

function probeFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Ask (unless --yes), run the installer, re-probe. The caller already printed the command. */
async function runInstall(
  deps: SetupDeps,
  options: SetupOptions,
  plan: InstallPlan,
  verify: () => Promise<{ found: boolean; output: string }>,
): Promise<{ outcome: Outcome; detail: string }> {
  deps.print(`  install command: ${plan.display}`);
  if (options.install === false || options.configDir) {
    return { outcome: "skipped", detail: "not installing (--no-install / --config-dir); run the command above yourself" };
  }
  if (!options.yes && !(await deps.confirm("  Run it now?"))) {
    return { outcome: "skipped", detail: "declined; run the command above yourself" };
  }
  const status = deps.run(plan);
  if (status !== 0) return { outcome: "FAILED", detail: `installer exited ${status}` };
  const after = await verify();
  return after.found
    ? { outcome: "done", detail: after.output.split("\n")[0] ?? "installed" }
    : { outcome: "done", detail: "installed, but not on PATH in this shell yet - open a new shell and re-run setup" };
}

async function stepGit(deps: SetupDeps, options: SetupOptions): Promise<Outcome> {
  const probe = await deps.probe("git", ["--version"]);
  if (probe.found && gitIsNewEnough(probe.output)) {
    deps.print(`[git] ok (already present) - ${probe.output.split("\n")[0]}`);
    return "ok (already present)";
  }
  const why = probe.found ? `${probe.output.split("\n")[0]} is older than 2.31` : "git is not installed";
  deps.print(`[git] ${why}; the worker needs git >= 2.31 (GIT_CONFIG_COUNT).`);
  const has = new Set<string>();
  for (const pm of ["apt-get", "dnf"]) if ((await deps.probe(pm, ["--version"])).found) has.add(pm);
  const plan = gitInstallPlan(deps.os, (c) => has.has(c), deps.isRoot);
  if (!plan) {
    deps.print("[git] FAILED - no known package manager here; install git >= 2.31 yourself and re-run setup");
    return "FAILED";
  }
  const res = await runInstall(deps, options, plan, () => deps.probe("git", ["--version"]));
  deps.print(`[git] ${res.outcome} - ${res.detail}`);
  return res.outcome;
}

async function stepCli(deps: SetupDeps, options: SetupOptions, providers: string[]): Promise<Outcome> {
  let worst: Outcome = "ok (already present)";
  for (const provider of providers) {
    const probe = await deps.probe(provider, ["--version"]);
    if (probe.found) {
      deps.print(`[cli ${provider}] ok (already present) - ${probe.output.split("\n")[0]}`);
      continue;
    }
    deps.print(`[cli ${provider}] not installed`);
    let userPrefix: string | undefined;
    if (provider === "codex" && deps.os === "linux") {
      const info = deps.npmPrefix();
      if (info && !info.writable) {
        userPrefix = join(deps.home, ".local");
        deps.print(
          `  The npm global prefix ${info.prefix} is root-owned; not using sudo. Installing into ${userPrefix} ` +
            `instead - add ${join(userPrefix, "bin")} to PATH.`,
        );
      }
    }
    const plan = providerInstallPlan(provider, deps.os, { userPrefix });
    if (!plan) {
      deps.print(`[cli ${provider}] skipped - no known installer for '${provider}'; install it yourself`);
      if (worst !== "FAILED") worst = "skipped";
      continue;
    }
    const res = await runInstall(deps, options, plan, () => deps.probe(provider, ["--version"]));
    deps.print(`[cli ${provider}] ${res.outcome} - ${res.detail}`);
    if (res.outcome === "FAILED") worst = "FAILED";
    else if (res.outcome === "skipped" && worst !== "FAILED") worst = "skipped";
    else if (res.outcome === "done" && worst === "ok (already present)") worst = "done";
  }
  return worst;
}

async function stepAuth(
  deps: SetupDeps,
  options: SetupOptions,
  providers: string[],
  harnessFor: (provider: AuthProvider) => WorkerHarness,
  stateFile: string,
): Promise<Outcome> {
  let worst: Outcome = "ok (already present)";
  const targets = providers.filter((p): p is AuthProvider => (AUTH_PROVIDERS as readonly string[]).includes(p));
  for (const provider of providers) {
    if (!targets.includes(provider as AuthProvider)) deps.print(`[auth ${provider}] skipped - no worker-managed login for '${provider}'`);
  }
  for (const provider of targets) {
    const harness = harnessFor(provider);
    harness.ensure(provider);
    const dir = harness.dirFor(provider) ?? "(inherited)";
    if (hasCredential(harness, provider, deps.nowMs ?? Date.now())) {
      deps.print(`[auth ${provider}] ok (already present) - login in ${dir}`);
      continue;
    }
    if (!(await deps.probe(provider, ["--version"])).found) {
      deps.print(`[auth ${provider}] skipped - the ${provider} CLI is not installed, so it cannot log in`);
      if (worst !== "FAILED") worst = "skipped";
      continue;
    }
    if (!options.yes && !(await deps.confirm(`  Log ${provider} into ${dir} now?`))) {
      deps.print(`[auth ${provider}] skipped - run: agentic-kanban-worker auth ${provider}`);
      if (worst !== "FAILED") worst = "skipped";
      continue;
    }
    const status = await deps.auth(provider, {
      stateFile,
      ...(options.configDir && provider === "claude" ? { configDir: options.configDir } : {}),
    });
    if (status === 0) {
      deps.print(`[auth ${provider}] done - login in ${dir}`);
      if (worst === "ok (already present)") worst = "done";
    } else {
      deps.print(`[auth ${provider}] FAILED - exit ${status}; retry: agentic-kanban-worker auth ${provider}`);
      worst = "FAILED";
    }
  }
  return worst;
}

async function stepPair(
  deps: SetupDeps,
  options: SetupOptions,
  board: string,
  stateFile: string,
  providers: string[],
  harness: WorkerHarness,
): Promise<Outcome> {
  if (readSavedIdentity(stateFile, board.replace(/\/+$/, ""))) {
    deps.print(`[pair] ok (already present) - already paired with ${board}`);
    return "ok (already present)";
  }
  if (!options.token) {
    deps.print("[pair] skipped - not paired and no --token given (mint one with `agentic-kanban worker pair` on the board)");
    return "skipped";
  }
  try {
    const res = await deps.pair({
      boardUrl: board,
      pairingToken: options.token,
      providers,
      harness,
      stateFile,
      ...(options.name ? { name: options.name } : {}),
      log: deps.print,
    });
    deps.print(`[pair] ${res.alreadyPaired ? "ok (already present)" : "done"} - paired with ${board} as '${res.name}'`);
    return res.alreadyPaired ? "ok (already present)" : "done";
  } catch (err) {
    deps.print(`[pair] FAILED - ${errorMessage(err)}`);
    return "FAILED";
  }
}

async function stepDoctor(deps: SetupDeps, opts: WorkerDoctorOptions): Promise<Outcome> {
  const report = await deps.doctor(opts);
  const remaining = report.checks.filter((c) => c.status === "fail" || c.status === "warn");
  const fails = remaining.filter((c) => c.status === "fail").length;
  deps.print(`[doctor] ${fails === 0 ? "ok" : "FAILED"} - ${fails} FAIL, ${remaining.length - fails} WARN`);
  for (const c of remaining) {
    deps.print(`  ${c.status === "fail" ? "FAIL" : "WARN"} ${c.name}: ${c.detail}`);
    if (c.remedy) deps.print(`       fix: ${c.remedy}`);
  }
  return fails === 0 ? "ok" : "FAILED";
}

/** Run the selected steps in order. Returns the process exit code. */
export async function runWorkerSetup(options: SetupOptions, deps: SetupDeps): Promise<number> {
  if (options.guide) {
    deps.print(renderWorkerSetupGuide());
    return 0;
  }
  // The dirty-machine case: a custom folder means no installs, just that claude folder plus auth.
  const customDir = Boolean(options.configDir);
  const requested = splitCsv(options.steps);
  const unknown = requested.filter((s) => !(SETUP_STEPS as readonly string[]).includes(s));
  if (unknown.length > 0) {
    deps.print(`unknown --steps value(s): ${unknown.join(", ")}; valid: ${SETUP_STEPS.join(",")}`);
    return 2;
  }
  const selected = new Set<string>(requested.length > 0 ? requested : customDir ? ["auth"] : SETUP_STEPS);
  const providers = options.providers ? splitCsv(options.providers) : customDir ? ["claude"] : ["claude", "codex"];
  const board = (options.board ?? DEFAULT_BOARD_URL).replace(/\/+$/, "");
  const stateFile = options.stateFile ?? defaultWorkerStateFile();
  const harnessFor = (provider: AuthProvider): WorkerHarness =>
    createWorkerHarness({
      stateFile,
      ...(options.configDir && provider === "claude" ? { claudeConfigDir: options.configDir } : {}),
    });
  const results: Outcome[] = [];

  if (selected.has("git")) results.push(await stepGit(deps, options));
  if (selected.has("cli")) results.push(await stepCli(deps, options, providers));
  if (selected.has("auth")) results.push(await stepAuth(deps, options, providers, harnessFor, stateFile));
  if (selected.has("pair")) {
    results.push(await stepPair(deps, options, board, stateFile, providers, harnessFor("claude")));
  }
  if (selected.has("doctor")) {
    results.push(await stepDoctor(deps, {
      boardUrl: board,
      stateFile,
      providers,
      harness: harnessFor("claude"),
    }));
  }
  const failed = results.includes("FAILED");
  deps.print(failed ? "setup finished with FAILED steps (see above)." : "setup finished.");
  if (!failed && options.start && selected.has("pair") && deps.start) await deps.start();
  return failed ? 1 : 0;
}

/** Registers `setup`; `start` is the daemon launcher from worker.ts (used only with --start). */
export function registerWorkerSetup(
  workerCmd: Command,
  ctx: { start: (options: SetupOptions) => Promise<void> },
): void {
  workerCmd
    .command("setup")
    .description(
      "Set this machine up as a worker, step by step (each step detects what is already there and can be " +
        "skipped): git >= 2.31, the claude/codex CLIs (installed after a y/N prompt), the worker's own config dir " +
        "+ login, pairing with --token, then `doctor`. Re-running is safe. --guide prints the offline guide.",
    )
    .option("--board <url>", "Board base URL (the FLEET port on a cross-machine setup)", DEFAULT_BOARD_URL)
    .option("--token <pairingToken>", "Pairing token minted by `worker pair` on the board")
    .option("--providers <csv>", "Providers to set up (default: claude,codex; with --config-dir: claude)")
    .option("--steps <csv>", `Run only these steps, any subset of: ${SETUP_STEPS.join(",")}`)
    .option("--no-install", "Only check and print the install commands; never run an installer")
    .option("--yes", "Do not ask before installing or logging in (unattended)")
    .option(
      "--config-dir <path>",
      "Dirty machine: use/create this claude config folder. No installs; defaults to --steps auth",
      cliPathArg,
    )
    .option("--start", "After pairing, keep running as the worker daemon")
    .option("--guide", "Print the offline setup guide and exit")
    .option("--name <name>", "Worker display name (default: hostname)")
    .option("--state-file <path>", "Pairing state file (default: ~/.agentic-kanban/worker-state.json)", cliPathArg)
    .action(async (options: SetupOptions) => {
      const code = await runWorkerSetup(options, defaultSetupDeps(() => ctx.start(options)));
      // --start leaves the daemon's own timers holding the process open; do not exit under it.
      if (!(code === 0 && options.start)) process.exit(code);
    });
}

/**
 * `agentic-kanban-worker setup` (#1368): turn a machine with only node into a paired worker, one
 * detecting, skippable step at a time: pair (first, #1388: the token expires) -> git -> provider CLIs
 * -> harness dir + auth -> doctor.
 * Every step says `ok (already present)` / `done` / `skipped`, so re-running is idempotent.
 * Nothing is installed without a prompt (or --yes) and `--no-install` never runs an installer.
 * Db-free: this is part of the standalone worker binary.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { readOAuthCredentials } from "../../lib/oauth-quota-core.js";
import { defaultWorkerStateFile, type WorkerDaemonOptions } from "../../worker/worker-daemon.js";
import { pairWorker } from "../../worker/worker-pair.js";
import { createWorkerHarness, type WorkerHarness } from "../../worker/worker-harness.js";
import { applyWorkerPath, prependPath, saveExtraPathDir } from "../../worker/worker-path.js";
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
  labels?: string;
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
  /** #1374: does this file exist (a CLI the installer dropped into a dir that is not on PATH)? */
  fileExists?: (path: string) => boolean;
  /** #1374: put `dir` first on this process's PATH and remember it for the daemon's spawn PATH. */
  addPath?: (dir: string, stateFile: string) => void;
  /** #1374: does the user's shell profile already add `dir` to PATH? */
  profileAddsDir?: (dir: string) => boolean;
  /** #1374: apply the worker's PATH policy (saved dirs, WSL /mnt entries off) before probing. */
  applyPath?: (stateFile: string) => void;
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
  return { prefix, writable: npmPrefixWritable(prefix, process.platform) };
}

/**
 * #1374: can `npm i -g` write here WITHOUT sudo? Not "who owns the prefix dir" (`/usr/local` is
 * root-owned yet `lib/node_modules` and `bin` are often user-writable): check what npm writes into.
 * On Windows the prefix itself is both.
 */
export function npmPrefixWritable(
  prefix: string,
  platform: NodeJS.Platform,
  canWrite: (path: string) => boolean = (p) => {
    try {
      accessSync(p, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
): boolean {
  if (platform === "win32") return canWrite(prefix);
  return canWrite(join(prefix, "lib", "node_modules")) && canWrite(join(prefix, "bin"));
}

function profileMentions(home: string, dir: string): boolean {
  const rel = dir.startsWith(home) ? dir.slice(home.length).replace(/^[\\/]+/, "") : dir;
  for (const f of [".profile", ".bash_profile", ".bashrc", ".zprofile", ".zshrc"]) {
    try {
      if (readFileSync(join(home, f), "utf8").includes(rel)) return true;
    } catch {
      /* file absent */
    }
  }
  return false;
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
    fileExists: (p) => existsSync(p),
    addPath: (dir, stateFile) => {
      prependPath(process.env, dir);
      saveExtraPathDir(stateFile, dir);
    },
    profileAddsDir: (dir) => profileMentions(homedir(), dir),
    applyPath: (stateFile) => applyWorkerPath(stateFile),
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
  if (provider === "claude") {
    const read = readOAuthCredentials(dir, nowMs);
    // An expired access token with a refresh token is still a login: claude refreshes it itself.
    return read.err === undefined || (read.err === "expired" && hasRefreshToken(dir));
  }
  return probeFile(join(dir, "auth.json"));
}

function hasRefreshToken(dir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8").replace(/^﻿/, ""));
    const token = (parsed as { claudeAiOauth?: { refreshToken?: unknown } } | null)?.claudeAiOauth?.refreshToken;
    return typeof token === "string" && token.length > 0;
  } catch {
    return false;
  }
}

function probeFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function quoteArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** The flags setup was given that change WHICH worker a follow-up command acts on (#1398). */
export function followUpFlags(options: SetupOptions, opts: { name?: boolean } = {}): string {
  const parts: string[] = [];
  if (options.configDir) parts.push(`--config-dir ${quoteArg(options.configDir)}`);
  if (options.stateFile) parts.push(`--state-file ${quoteArg(options.stateFile)}`);
  if (opts.name && options.name) parts.push(`--name ${quoteArg(options.name)}`);
  if (opts.name && options.labels) parts.push(`--labels ${quoteArg(options.labels)}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** Ask (unless --yes), run the installer, re-probe. The caller already printed the command. */
async function runInstall(
  deps: SetupDeps,
  options: SetupOptions,
  plan: InstallPlan,
  verify: () => Promise<{ found: boolean; output: string }>,
  /** #1374: where the installer is known to drop `program`, so a not-yet-on-PATH install is still used. */
  locate?: { program: string; dirs: string[]; stateFile: string; addedDirs: Set<string> },
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
  let after = await verify();
  if (!after.found && locate && deps.fileExists && deps.addPath) {
    const names = deps.os === "win32" ? [`${locate.program}.exe`, `${locate.program}.cmd`] : [locate.program];
    const dir = locate.dirs.find((d) => names.some((n) => deps.fileExists!(join(d, n))));
    if (dir) {
      deps.addPath(dir, locate.stateFile);
      locate.addedDirs.add(dir);
      after = await verify();
      if (after.found) {
        return {
          outcome: "done",
          detail: `${after.output.split("\n")[0] ?? "installed"} (found in ${dir}; added to PATH for the rest of setup and saved for the worker daemon)`,
        };
      }
    }
  }
  return after.found
    ? { outcome: "done", detail: after.output.split("\n")[0] ?? "installed" }
    : { outcome: "done", detail: "installed, but its location could not be found, so it is not on PATH in this shell yet - open a new shell and re-run setup" };
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

async function stepCli(
  deps: SetupDeps,
  options: SetupOptions,
  providers: string[],
  stateFile: string,
): Promise<Outcome> {
  let worst: Outcome = "ok (already present)";
  const addedDirs = new Set<string>();
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
          `  The npm global prefix ${info.prefix} is not writable by this user (${join(info.prefix, "lib", "node_modules")} ` +
            `/ ${join(info.prefix, "bin")}); not using sudo. Installing into ${userPrefix} instead.`,
        );
      }
    }
    const plan = providerInstallPlan(provider, deps.os, { userPrefix });
    if (!plan) {
      deps.print(`[cli ${provider}] skipped - no known installer for '${provider}'; install it yourself`);
      if (worst !== "FAILED") worst = "skipped";
      continue;
    }
    // claude's installer drops into ~/.local/bin; npm --prefix <p> into <p>/bin.
    const dirs = [join(deps.home, ".local", "bin"), ...(userPrefix ? [join(userPrefix, "bin")] : [])];
    const res = await runInstall(deps, options, plan, () => deps.probe(provider, ["--version"]), {
      program: provider,
      dirs,
      stateFile,
      addedDirs,
    });
    deps.print(`[cli ${provider}] ${res.outcome} - ${res.detail}`);
    if (res.outcome === "FAILED") worst = "FAILED";
    else if (res.outcome === "skipped" && worst !== "FAILED") worst = "skipped";
    else if (res.outcome === "done" && worst === "ok (already present)") worst = "done";
  }
  // Said once, not per CLI: does the login shell pick the dir up on its own?
  for (const dir of addedDirs) {
    if (deps.profileAddsDir?.(dir)) {
      deps.print(`  Your shell profile already adds ${dir} to PATH (a new login shell will have it).`);
    } else {
      deps.print(`  To use these CLIs from your own shell too, add this line to your shell profile: export PATH="${dir}:$PATH"`);
    }
  }
  return worst;
}

/** Exit statuses of a login the operator interrupted with Ctrl+C (POSIX SIGINT, Windows STATUS_CONTROL_C_EXIT). */
const INTERRUPT_STATUSES: ReadonlySet<number> = new Set([130, 3221225786, -1073741510]);

function authFlags(options: SetupOptions, provider: AuthProvider): string {
  return followUpFlags({ ...(options.stateFile ? { stateFile: options.stateFile } : {}), ...(options.configDir && provider === "claude" ? { configDir: options.configDir } : {}) });
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
      deps.print(`[auth ${provider}] skipped - run: agentic-kanban-worker auth ${provider}${authFlags(options, provider)}`);
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
    } else if (INTERRUPT_STATUSES.has(status)) {
      deps.print(`[auth ${provider}] login skipped - run agentic-kanban-worker auth ${provider}${authFlags(options, provider)}`);
      if (worst !== "FAILED") worst = "skipped";
    } else {
      deps.print(`[auth ${provider}] FAILED - exit ${status}; retry: agentic-kanban-worker auth ${provider}${authFlags(options, provider)}`);
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
  attest = true,
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
      ...(attest ? {} : { attestProviders: false }),
      ...(options.name ? { name: options.name } : {}),
      ...(options.labels ? { labels: splitCsv(options.labels) } : {}),
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
  if (options.token && requested.length > 0 && !requested.includes("pair")) {
    deps.print("--token was given but --steps excludes 'pair', so it would be ignored; add 'pair' to --steps or drop --token");
    return 2;
  }
  // --token always means "pair": a custom folder alone is auth-only, with a token it is auth,pair,doctor.
  const defaultSteps: readonly string[] = customDir ? (options.token ? ["auth", "pair", "doctor"] : ["auth"]) : SETUP_STEPS;
  const selected = new Set<string>(requested.length > 0 ? requested : defaultSteps);
  const providers = options.providers ? splitCsv(options.providers) : customDir ? ["claude"] : ["claude", "codex"];
  const board = (options.board ?? DEFAULT_BOARD_URL).replace(/\/+$/, "");
  const stateFile = options.stateFile ?? defaultWorkerStateFile();
  const harnessFor = (provider: AuthProvider): WorkerHarness =>
    createWorkerHarness({
      stateFile,
      ...(options.configDir && provider === "claude" ? { claudeConfigDir: options.configDir } : {}),
    });
  const results: Outcome[] = [];

  deps.applyPath?.(stateFile);
  // The pairing token lives ~10 minutes and a browser login can outlast it (#1388): when slow
  // interactive steps follow, exchange the token FIRST. Attestation is skipped then (nothing is
  // installed yet, it would attest nothing); the closing doctor reports what is really usable.
  const slowStepsFollow = selected.has("git") || selected.has("cli") || selected.has("auth");
  const pairFirst = selected.has("pair") && slowStepsFollow;
  if (pairFirst) {
    results.push(await stepPair(deps, options, board, stateFile, providers, harnessFor("claude"), false));
  }
  if (selected.has("git")) results.push(await stepGit(deps, options));
  if (selected.has("cli")) results.push(await stepCli(deps, options, providers, stateFile));
  if (selected.has("auth")) results.push(await stepAuth(deps, options, providers, harnessFor, stateFile));
  if (selected.has("pair") && !pairFirst) {
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
  if (!failed && selected.has("pair") && !options.start) {
    deps.print("Next, start the worker (add --start to setup to do this automatically):");
    deps.print(`  agentic-kanban-worker start --board ${board}${followUpFlags(options, { name: true })} --auto-update`);
  }
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
    .option("--name <name>", "Worker display name (default: hostname; <hostname>-wsl-<distro> under WSL)")
    .option("--labels <csv>", "Capability labels, e.g. docker,windows")
    .option("--state-file <path>", "Pairing state file (default: ~/.agentic-kanban/worker-state.json)", cliPathArg)
    .action(async (options: SetupOptions) => {
      const code = await runWorkerSetup(options, defaultSetupDeps(() => ctx.start(options)));
      // --start leaves the daemon's own timers holding the process open; do not exit under it.
      if (!(code === 0 && options.start)) process.exit(code);
    });
}

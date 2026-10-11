/**
 * `agentic-kanban-worker auth <claude|codex>` (#1367): log a provider into the WORKER's own
 * config dir with the provider's own flow. The credential is created on this machine and never
 * leaves it - the board stores and relays nothing (decision 012). Db-free (standalone binary).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Command } from "commander";
import { readOAuthCredentials } from "../../lib/oauth-quota-core.js";
import { homedir } from "node:os";
import {
  createWorkerHarness,
  findWorkerStateFiles,
  resolveInspectedHarness,
  stateFileUsesDir,
  type SecretProtector,
  type WorkerHarness,
} from "../../worker/worker-harness.js";
import { cliPathArg } from "../cli-path.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export const AUTH_PROVIDERS = ["claude", "codex"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export interface AuthPlan {
  command: string;
  args: string[];
  /** Printed before the command runs. */
  note: string;
}

/** What to run for the plain (non-token) login. Pure, so it is testable without a CLI. */
export function planAuth(
  provider: AuthProvider,
  dir: string,
  opts: { claudeHasAuthLogin: boolean; hasDisplay: boolean; deviceAuth?: boolean },
): AuthPlan {
  if (provider === "codex") {
    const device = opts.deviceAuth ?? !opts.hasDisplay;
    return {
      command: "codex",
      args: device ? ["login", "--device-auth"] : ["login"],
      note: `Logging codex into ${dir}${device ? " (device auth: no browser/display here)" : ""}.`,
    };
  }
  if (opts.claudeHasAuthLogin) {
    return { command: "claude", args: ["auth", "login"], note: `Logging claude into ${dir}.` };
  }
  return {
    command: "claude",
    args: [],
    note: `This claude has no non-interactive login subcommand. claude will start with its config in ${dir}: ` +
      "type /login, finish the login, then /exit.",
  };
}

export interface AuthDeps {
  /** Run a command attached to the terminal; returns its exit status. */
  run: (command: string, args: string[], env: NodeJS.ProcessEnv) => number;
  /** Does `claude auth --help` succeed? */
  claudeHasAuthLogin: () => boolean;
  readSecret: (prompt: string) => Promise<string>;
  hasDisplay: () => boolean;
  print: (line: string) => void;
  /** Test seam: how the token is sealed at rest. Default = DPAPI on Windows, 0600 file elsewhere. */
  protector?: SecretProtector;
  /** Test seam: the home dir holding the default state file and the registry of state files. */
  home?: string;
}

function defaultDeps(): AuthDeps {
  const shell = process.platform === "win32"; // npm shims are .cmd on Windows
  return {
    run: (command, args, env) =>
      spawnSync(command, args, { stdio: "inherit", env, shell, windowsHide: true }).status ?? 1,
    claudeHasAuthLogin: () =>
      spawnSync("claude", ["auth", "--help"], { stdio: "ignore", shell, windowsHide: true }).status === 0,
    readSecret: readSecretFromTty,
    hasDisplay: () => process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    print: (line) => console.log(line),
  };
}

/** Read a line without echoing it. */
function readSecretFromTty(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
    process.stdout.write(prompt);
  });
}

export interface WorkerAuthOptions {
  token?: boolean;
  status?: boolean;
  deviceAuth?: boolean;
  configDir?: string;
  stateFile?: string;
}

interface LocatedHarness {
  harness: WorkerHarness;
  stateFile: string;
  /** Lines to print first: flag/record disagreements, where the state file came from. */
  notes: string[];
  /** The pairing still runs in inherit mode: the login goes where `--clean` will read. */
  legacyInherit: boolean;
}

/**
 * The harness a worker really uses (#1373): the state file decides. Without `--state-file`, a
 * `--config-dir` is matched to the registered state file that records it (the dir and the state
 * file are linked), so the token and the login land where that worker reads them.
 */
function locateHarness(
  provider: AuthProvider | undefined,
  options: WorkerAuthOptions,
  deps: { home?: string; protector?: SecretProtector },
  forLogin: boolean,
): LocatedHarness {
  const home = deps.home ?? homedir();
  const defaultFile = join(home, ".agentic-kanban", "worker-state.json");
  const notes: string[] = [];
  let stateFile = options.stateFile;
  if (!stateFile) {
    const matched = options.configDir && provider
      ? findWorkerStateFiles(defaultFile, home).find((f) => stateFileUsesDir(f, provider, options.configDir!))
      : undefined;
    stateFile = matched ?? defaultFile;
    if (matched) notes.push(`--config-dir ${options.configDir} is the folder worker state ${matched} records; using that state file.`);
  }
  const flags = options.configDir
    ? provider === "codex" ? { codexHome: options.configDir } : { configDir: options.configDir }
    : {};
  const cfg = resolveInspectedHarness(stateFile, flags);
  notes.push(...cfg.differences);
  // A pairing still in inherit mode has no folder of its own yet: log into the one `--clean` will use.
  const options2 = forLogin && cfg.mode === "inherit" ? { ...cfg.options, inheritUserConfig: false } : cfg.options;
  return {
    harness: createWorkerHarness(options2, deps.protector),
    stateFile,
    notes,
    legacyInherit: cfg.mode === "inherit",
  };
}

/** `auth --status` with no `--state-file`: the worker state files this machine knows, with their modes. */
export function listWorkerStateFiles(home: string = homedir()): string[] {
  const defaultFile = join(home, ".agentic-kanban", "worker-state.json");
  const files = findWorkerStateFiles(defaultFile, home);
  if (files.length === 0) return [`no worker state file found (default home: ${defaultFile})`];
  const lines = [`worker state files found (${files.length}):`];
  for (const f of files) {
    const cfg = resolveInspectedHarness(f);
    const dirs = [cfg.options.claudeConfigDir && `claude ${cfg.options.claudeConfigDir}`, cfg.options.codexHome && `codex ${cfg.options.codexHome}`]
      .filter(Boolean)
      .join(", ");
    lines.push(`  ${f}: ${cfg.legacyInherit ? "inherit (pairing predates harness modes)" : cfg.mode}${dirs ? ` (${dirs})` : ""}`);
  }
  return lines;
}

/** `auth --status`: which mode each provider uses and the expiry if known. Never the secret. */
export function renderAuthStatus(harness: WorkerHarness, nowMs: number = Date.now()): string[] {
  const lines: string[] = [`state file: ${harness.stateFile}`, `harness mode: ${harness.mode}`];
  for (const provider of AUTH_PROVIDERS) {
    const dir = harness.dirFor(provider);
    const token = harness.tokenStatus(provider, nowMs);
    let state: string;
    if (provider === "claude" && token.stored) {
      const exp = token.expiresAtMs ? `, expires about ${new Date(token.expiresAtMs).toISOString().slice(0, 10)}` : "";
      state = `token (stored by the worker${token.expired ? ", EXPIRED" : ""}${exp}) injected as CLAUDE_CODE_OAUTH_TOKEN`;
    } else if (!dir) {
      state = "inherited: this machine's own login/env (inherit mode)";
    } else if (provider === "claude") {
      const read = readOAuthCredentials(dir, nowMs);
      state = read.err === undefined || (read.err === "expired" && read.refreshable)
        ? `login in ${dir}`
        : read.err === "expired"
          ? `login in ${dir} EXPIRED`
          : `not logged in (${dir})`;
    } else {
      state = existsSync(join(dir, "auth.json")) ? `login in ${dir}` : `not logged in (${dir})`;
    }
    lines.push(`${provider}: ${state}`);
  }
  return lines;
}

export async function runWorkerAuth(
  providerArg: string | undefined,
  options: WorkerAuthOptions,
  deps: AuthDeps = defaultDeps(),
  nowMs: number = Date.now(),
): Promise<number> {
  if (options.status) {
    if (!options.stateFile) {
      // #1373 F2: without --state-file this describes the default home, which no worker may use.
      for (const line of listWorkerStateFiles(deps.home)) deps.print(line);
      deps.print("showing the DEFAULT home below; pass --state-file <file> for a specific worker:");
    }
    const located = locateHarness(undefined, options, deps, false);
    for (const note of located.notes) deps.print(`note: ${note}`);
    for (const line of renderAuthStatus(located.harness, nowMs)) deps.print(line);
    return 0;
  }
  const provider = providerArg as AuthProvider | undefined;
  if (!provider || !AUTH_PROVIDERS.includes(provider)) {
    deps.print(`usage: agentic-kanban-worker auth <${AUTH_PROVIDERS.join("|")}> [--config-dir <path>] [--token] [--device-auth] | auth --status`);
    return 2;
  }
  const located = locateHarness(provider, options, deps, true);
  const harness = located.harness;
  for (const note of located.notes) deps.print(`note: ${note}`);
  if (located.legacyInherit) {
    deps.print(
      "note: this worker still runs in inherit mode (your own ~/.claude). Logging into the worker's own folder " +
        "below; restart with --clean to switch to it.",
    );
  }
  const dir = harness.dirFor(provider)!;
  harness.ensure(provider);
  const env: NodeJS.ProcessEnv = { ...process.env, [provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: dir };

  if (options.token) {
    if (provider !== "claude") {
      deps.print("--token is only supported for claude (it runs 'claude setup-token').");
      return 2;
    }
    deps.print("Running 'claude setup-token' - open the URL on any device, then paste the code back here.");
    const status = deps.run("claude", ["setup-token"], env);
    if (status !== 0) {
      deps.print(`'claude setup-token' failed (exit ${status}); nothing was stored.`);
      return status;
    }
    const token = await deps.readSecret("Paste the token that setup-token printed (input is hidden): ");
    if (!token || /\s/.test(token)) {
      deps.print("No usable token entered; nothing was stored.");
      return 1;
    }
    try {
      harness.storeToken(provider, token, nowMs);
    } catch (err) {
      deps.print(`Could not store the token: ${errorMessage(err)}`);
      return 1;
    }
    deps.print(
      `Token stored by the worker in ${harness.tokenPath(provider)} (state file ${harness.stateFile}; never logged, never sent ` +
        "to the board). Claude sessions of the worker started with that state file get it as CLAUDE_CODE_OAUTH_TOKEN.",
    );
    return 0;
  }

  const plan = planAuth(provider, dir, {
    claudeHasAuthLogin: provider === "claude" ? deps.claudeHasAuthLogin() : false,
    hasDisplay: deps.hasDisplay(),
    ...(options.deviceAuth !== undefined ? { deviceAuth: options.deviceAuth } : {}),
  });
  deps.print(plan.note);
  return deps.run(plan.command, plan.args, env);
}

/** `--inherit-user-config` / `--config-dir` / `--codex-home`, shared by `worker start` and `worker doctor`. */
export function addHarnessOptions(cmd: Command): Command {
  return cmd
    .option(
      "--inherit-user-config",
      "Dirty mode (#1367): run sessions with THIS machine's own ~/.claude / ~/.codex and env (user hooks, " +
        "plugins, skills, global CLAUDE.md) instead of the worker's clean harness config dir. " +
        "Results then depend on the machine.",
    )
    .option(
      "--clean",
      "Clean mode (#1373): run sessions in the worker's own <state-dir>/harness config. This is the default for " +
        "a NEW pairing; a pairing that predates harness modes keeps inherit until you pass --clean. " +
        "The chosen mode and folders are recorded in the state file by 'start'.",
    )
    .option(
      "--config-dir <path>",
      "Run claude sessions with this existing config folder (CLAUDE_CONFIG_DIR) instead of the worker's " +
        "own <state-dir>/harness/claude, e.g. a dedicated ~/.claude-worker. Log in with 'auth claude --config-dir <path>'.",
      cliPathArg,
    )
    .option("--codex-home <path>", "Same as --config-dir, for codex (CODEX_HOME)", cliPathArg);
}

export function registerWorkerAuth(workerCmd: Command): void {
  workerCmd
    .command("auth [provider]")
    .description(
      "Log a provider (claude|codex) into THIS worker's own config dir with the provider's own login flow. " +
        "The credential is created here and never leaves this machine. 'auth claude --token' runs " +
        "'claude setup-token' (works headless) and stores the token for claude sessions; 'auth --status' " +
        "shows which mode each provider uses (never the secret).",
    )
    .option("--config-dir <path>", "Use this existing folder instead of the worker's own harness dir (same as 'start --config-dir' / '--codex-home')", cliPathArg)
    .option("--token", "claude only: run 'claude setup-token' and store the token in the worker's state")
    .option("--device-auth", "codex only: force 'codex login --device-auth' (default when there is no browser/display)")
    .option("--status", "Print which mode each provider uses and the token expiry if known")
    .option("--state-file <path>", "Pairing state file; the harness dir lives beside it", cliPathArg)
    .action(async (provider: string | undefined, options: WorkerAuthOptions) => {
      process.exit(await runWorkerAuth(provider, options));
    });
}

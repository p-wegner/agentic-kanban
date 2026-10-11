/**
 * What `agentic-kanban-worker setup` installs, and how (#1368). Pure: it only DECIDES the command
 * for an OS; running it, and asking first, is `worker-setup.ts`. Db-free (standalone binary).
 */

export type SetupOs = "win32" | "darwin" | "linux";

/** The git floor: the worker injects its auth header through GIT_CONFIG_COUNT (git >= 2.31). */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 31];

export interface InstallPlan {
  command: string;
  args: string[];
  /** The exact line shown to the user before they are asked. */
  display: string;
  /** npm shims are .cmd on Windows, which needs a shell to resolve. */
  shell: boolean;
}

function plan(command: string, args: string[], display: string, shell = false): InstallPlan {
  return { command, args, display, shell };
}

/** `git version 2.43.0.windows.1` -> [2, 43]; null when unparseable. */
export function parseGitVersion(output: string): [number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.\d+)?/.exec(output);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function gitIsNewEnough(output: string): boolean {
  const v = parseGitVersion(output);
  if (!v) return false;
  return v[0] > MIN_GIT_VERSION[0] || (v[0] === MIN_GIT_VERSION[0] && v[1] >= MIN_GIT_VERSION[1]);
}

/** The package-manager command for git on this OS, or null when none is known here. */
export function gitInstallPlan(os: SetupOs, has: (cmd: string) => boolean, isRoot: boolean): InstallPlan | null {
  if (os === "win32") {
    const args = ["install", "--id", "Git.Git", "-e", "--source", "winget"];
    return plan("winget", args, `winget ${args.join(" ")}`);
  }
  if (os === "darwin") return plan("brew", ["install", "git"], "brew install git");
  const sudo = isRoot ? [] : ["sudo"];
  if (has("apt-get")) {
    const argv = [...sudo, "apt-get", "install", "-y", "git"];
    return plan(argv[0]!, argv.slice(1), argv.join(" "));
  }
  if (has("dnf")) {
    const argv = [...sudo, "dnf", "install", "-y", "git"];
    return plan(argv[0]!, argv.slice(1), argv.join(" "));
  }
  return null;
}

export interface NpmPrefixInfo {
  prefix: string;
  writable: boolean;
}

/**
 * How to install a provider CLI with the vendor's official method. claude: its native installer
 * (a script the vendor serves); codex: `npm i -g @openai/codex`. Null = no known installer.
 *
 * On Linux with a root-owned npm prefix `userPrefix` switches npm to a user-writable prefix
 * rather than reaching for sudo.
 */
export function providerInstallPlan(
  provider: string,
  os: SetupOs,
  opts: { userPrefix?: string } = {},
): InstallPlan | null {
  if (provider === "claude") {
    if (os === "win32") {
      const script = "irm https://claude.ai/install.ps1 | iex";
      return plan(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script}"`,
      );
    }
    const script = "curl -fsSL https://claude.ai/install.sh | bash";
    return plan("bash", ["-c", script], script);
  }
  if (provider === "codex") {
    const args = ["i", "-g", ...(opts.userPrefix ? ["--prefix", opts.userPrefix] : []), "@openai/codex"];
    return plan("npm", args, `npm ${args.join(" ")}`, os === "win32");
  }
  return null;
}

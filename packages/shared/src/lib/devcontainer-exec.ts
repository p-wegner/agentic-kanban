import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The single sanctioned adapter for spawning the `devcontainer` CLI.
 *
 * Mirrors `docker-exec.ts` / `git-exec.ts`: the devcontainer CLI is an external
 * system and this module is its port.
 *
 * Deliberate split of responsibilities — the devcontainer CLI is used ONLY to
 * provision (`devcontainer up`), never to run the agent:
 *
 *   provision  -> `devcontainer up`  (cold path, once per workspace, shell OK)
 *   agent run  -> `docker exec`      (hot path, via docker-exec.ts)
 *
 * Why: on Windows the globally-installed `devcontainer` is a `.cmd` shim, so
 * spawning it requires `shell: true` — and `shouldDetachAgent()` refuses to
 * detach a shell-spawned agent (detaching breaks its stdout pipe). Routing the
 * agent through `docker exec` (a real executable) keeps the existing detach +
 * stdio-file behaviour intact. `devcontainer up` reports the containerId, so the
 * hot path never needs the shim.
 *
 * Node-only: imports `node:child_process`, so it must never be value-exported
 * from the `@agentic-kanban/shared/lib` barrel (that would white-screen the
 * client bundle, see #791). It is re-exported from the barrel as `export type *`
 * only. Import the runtime via its deep path:
 * `@agentic-kanban/shared/lib/devcontainer-exec`.
 */

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/** Provisioning pulls/builds an image on a cold cache — this needs to be generous. */
const DEFAULT_UP_TIMEOUT_MS = 600000;

export interface DevcontainerExecResult {
  stdout: string;
  stderr: string;
  /** `0` on success, the numeric exit code on non-zero exit, `-1` when the CLI failed to spawn (see `error`). */
  code: number;
  /** The spawn/exec error message when the CLI failed to run, else undefined. */
  error?: string;
}

export interface DevcontainerExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * A provisioned devcontainer, as reported by `devcontainer up`. This is the
 * handle the agent hot path needs in order to build its `docker exec`
 * invocation — notably `remoteWorkspaceFolder`, since the container's view of
 * the worktree is NOT the host path.
 */
export interface DevcontainerHandle {
  containerId: string;
  /** The user the CLI resolved from the config (`remoteUser`), e.g. "node". */
  remoteUser: string;
  /** The worktree's path INSIDE the container, e.g. "/workspaces/taskflow". */
  remoteWorkspaceFolder: string;
}

/**
 * Run the devcontainer CLI and resolve with {stdout, stderr, code, error} —
 * NEVER rejects. On a non-zero exit `code` is the numeric exit code; on a spawn
 * failure (ENOENT/timeout) `code` is -1 and `error` holds the message.
 *
 * `shell: true` because the npm-global `devcontainer` is a `.cmd` shim on
 * Windows. This is the cold provisioning path only — see the module comment for
 * why the agent hot path must not go through here.
 */
export function devcontainerExec(
  args: string[],
  opts: DevcontainerExecOptions = {},
): Promise<DevcontainerExecResult> {
  const { cwd, env, timeoutMs = DEFAULT_UP_TIMEOUT_MS } = opts;
  return new Promise((resolve) => {
    execFile(
      "devcontainer",
      args,
      {
        cwd,
        env,
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER,
        windowsHide: true,
        shell: true,
      },
      (err, stdout, stderr) => {
        const out = stdout == null ? "" : stdout.toString();
        const errOut = stderr == null ? "" : stderr.toString();
        if (err) {
          const rawCode = (err as ExecFileException).code;
          const code = typeof rawCode === "number" ? rawCode : -1;
          resolve({ stdout: out, stderr: errOut, code, error: err.message });
          return;
        }
        resolve({ stdout: out, stderr: errOut, code: 0 });
      },
    );
  });
}

/** true if `devcontainer --version` exits 0 within a short timeout. */
export async function devcontainerAvailable(env?: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await devcontainerExec(["--version"], { env, timeoutMs: 15000 });
  return result.code === 0;
}

/**
 * true if the worktree declares a devcontainer. Both layouts the spec allows are
 * accepted: `.devcontainer/devcontainer.json` and a root `.devcontainer.json`.
 */
export function hasDevcontainerConfig(worktreePath: string): boolean {
  return (
    existsSync(join(worktreePath, ".devcontainer", "devcontainer.json")) ||
    existsSync(join(worktreePath, ".devcontainer.json"))
  );
}

/**
 * Parse the `devcontainer up` result line.
 *
 * The CLI writes a progress log to stdout and terminates with a single JSON
 * object, so we scan backwards for the last parseable line rather than parsing
 * the whole stream. Returns undefined when the output holds no successful
 * result object.
 */
export function parseDevcontainerUpResult(stdout: string): DevcontainerHandle | undefined {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.outcome !== "success") continue;
    const containerId = obj.containerId;
    const remoteWorkspaceFolder = obj.remoteWorkspaceFolder;
    if (typeof containerId !== "string" || typeof remoteWorkspaceFolder !== "string") continue;
    return {
      containerId,
      remoteUser: typeof obj.remoteUser === "string" ? obj.remoteUser : "root",
      remoteWorkspaceFolder,
    };
  }
  return undefined;
}

/**
 * A mount the BOARD injects at provision time (not declared by the repo).
 *
 * `bind` shares a host directory (the profile, the host temp dir). `volume`
 * attaches a container-managed named volume — used for dependency directories,
 * which must NOT live on a Windows bind mount (#138: rename-heavy installs flake
 * with EACCES on the 9p/virtiofs layer, and every file read pays a round trip).
 */
export interface DevcontainerMount {
  /** Defaults to "bind". */
  type?: "bind" | "volume";
  /** Host path for a bind mount, or the volume NAME for a volume mount. */
  source: string;
  target: string;
}

/** @deprecated Use {@link DevcontainerMount}. Retained for readability at bind-only call sites. */
export type DevcontainerBindMount = DevcontainerMount;

export interface DevcontainerUpOptions extends DevcontainerExecOptions {
  /**
   * Mounts injected via `--mount`. This is how agent credentials and dependency
   * volumes reach the container WITHOUT the target repo having to declare them in
   * its devcontainer.json — the repo owns its toolchain, the board owns the rest.
   */
  mounts?: DevcontainerMount[];
}

/** `--mount` takes a docker-style `type=<t>,source=...,target=...` descriptor. */
export function formatMount(mount: DevcontainerMount): string {
  return `type=${mount.type ?? "bind"},source=${mount.source},target=${mount.target}`;
}

/**
 * Bring up (or reuse) the devcontainer for a worktree and return its handle.
 * Resolves undefined when provisioning failed — callers fall back to host
 * execution rather than failing the workspace outright.
 */
export async function devcontainerUp(
  worktreePath: string,
  opts: DevcontainerUpOptions = {},
): Promise<DevcontainerHandle | undefined> {
  const { mounts = [], ...execOpts } = opts;
  const args = ["up", "--workspace-folder", worktreePath];
  for (const mount of mounts) {
    args.push("--mount", formatMount(mount));
  }
  const result = await devcontainerExec(args, execOpts);
  if (result.code !== 0) return undefined;
  return parseDevcontainerUpResult(result.stdout);
}

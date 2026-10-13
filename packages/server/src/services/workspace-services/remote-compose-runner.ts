/**
 * The `ComposeRunner` for a workspace whose session runs on a fleet worker (#1447, part b of #1432):
 * the same compose argv as the default runner, executed ON the worker inside its checkout of the
 * workspace branch, instead of against the host's daemon and the host's (dependency-less) worktree.
 *
 * Paths are the one real translation. The engine hands the runner HOST absolute paths; the worker has
 * its own checkout elsewhere, so every path is sent relative to the compose worktree root and the
 * generated env file travels as content (`@ENVFILE` in the argv is replaced by the worker with a
 * file it writes itself). Daemon-wide inventory (`list`, residue sweeps) is a HOST concern — the
 * startup reaper only ever scans the host's daemon — so those answer empty here.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { ComposeRunner } from "./compose-runner.js";
import type { WorkerServicesClient } from "../worker-services-client.js";

export interface RemoteComposeTarget {
  client: WorkerServicesClient;
  workerId: string;
  sessionId: string;
  workspaceId: string;
  /** Host path of the worktree holding the compose file: the root every path is made relative to. */
  hostRoot: string;
}

export function createRemoteComposeRunner(target: RemoteComposeTarget, readEnv: (path: string) => string = (p) => readFileSync(p, "utf8")): ComposeRunner {
  const { client, workerId, sessionId, workspaceId, hostRoot } = target;
  const rel = (path: string): string => relative(hostRoot, path).replaceAll("\\", "/") || ".";
  const files = (composeFile: string, extra?: string[]): string[] => ["-f", rel(composeFile), ...(extra ?? []).flatMap((f) => ["-f", rel(f)])];

  async function run(label: string, argv: string[], opts: { cwd?: string; envFile?: string; timeoutMs?: number; scratch?: boolean }) {
    const res = await client.exec({
      workerId, sessionId, workspaceId, label, argv,
      ...(opts.envFile ? { envFile: readEnv(opts.envFile) } : {}),
      ...(opts.cwd ? { cwdRel: rel(opts.cwd) === "." ? "" : rel(opts.cwd) } : {}),
      ...(opts.scratch ? { scratch: true } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return { ok: res.ok, stdout: res.stdout ?? "", stderr: res.ok ? (res.stderr ?? "") : (res.error ?? res.stderr ?? "compose failed on the worker") };
  }

  return {
    async up({ composeFile, extraComposeFiles, cwd, projectName, envFile, timeoutMs, forceRecreate }) {
      const flags = forceRecreate ? ["up", "-d", "--wait", "--force-recreate"] : ["up", "-d", "--wait"];
      const { ok, stderr } = await run("compose-up", ["docker", "compose", "-p", projectName, ...files(composeFile, extraComposeFiles), "--env-file", "@ENVFILE", ...flags], { cwd, envFile, timeoutMs });
      return { ok, stderr };
    },
    async down({ projectName, removeVolumes }) {
      const flags = removeVolumes === false ? ["down", "--remove-orphans"] : ["down", "-v", "--rmi", "local", "--remove-orphans"];
      const { ok, stderr } = await run("compose-down", ["docker", "compose", "-p", projectName, ...flags], { scratch: true, timeoutMs: 120_000 });
      return { ok, stderr };
    },
    async restart({ composeFile, extraComposeFiles, projectName, cwd, envFile, timeoutMs }) {
      const { ok, stderr } = await run("compose-restart", ["docker", "compose", "-p", projectName, ...files(composeFile, extraComposeFiles), "--env-file", "@ENVFILE", "restart"], { cwd, envFile, timeoutMs: timeoutMs ?? 120_000 });
      return { ok, stderr };
    },
    async logs({ composeFile, extraComposeFiles, projectName, cwd, envFile, tail, timeoutMs }) {
      const safeTail = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 200;
      return run("compose-logs", ["docker", "compose", "-p", projectName, ...files(composeFile, extraComposeFiles), "--env-file", "@ENVFILE", "logs", "--no-color", "--tail", String(safeTail)], { cwd, envFile, timeoutMs: timeoutMs ?? 20_000 });
    },
    list: async () => [],
    listResidualProjects: async () => [],
    removeResidualProjectResources: async () => ({ ok: true, stderr: "" }),
  };
}

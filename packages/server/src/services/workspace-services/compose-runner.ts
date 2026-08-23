/**
 * The `docker compose` CLI adapter for the per-workspace service-stack engine.
 *
 * This is the ONLY place that knows the shape of a compose command line — which flags a
 * teardown needs, that `logs` must never be given `--follow`, that container-less residue
 * has to be hunted by LABEL because `compose down -p` resolves a project from container
 * labels alone. It is the port; `workspace-services.service.ts` is the engine that decides
 * WHEN to call it, and injects a fake in tests.
 *
 * These functions belong together because they share exactly one thing: the compose CLI's
 * surface. None of them touches the engine's dependencies, its per-workspace state, or the
 * database — every method is a pure translation from typed arguments to a docker argv and
 * back, guarded by `dockerAvailable()` so a host without docker no-ops cleanly instead of
 * throwing. `isPortInUseError` sits here for the same reason: it reads compose's stderr,
 * which is this module's vocabulary, even though the retry decision it feeds is the
 * engine's.
 */

import { execErrorMessage, execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { dockerExec, dockerAvailable } from "@agentic-kanban/shared/lib/docker-exec";

/** The label compose stamps on every resource (container, volume, network, image) it
 *  creates, carrying the compose project name — the join key for label-based inventory
 *  of container-less residue (#163). */
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/**
 * The compose driver, injected for testability. The default implementation shells out
 * to `docker compose` via the docker-exec adapter; tests pass a fake.
 */
export interface ComposeRunner {
  up(args: {
    composeFile: string;
    /** Additional compose files (absolute paths) merged in via extra `-f` flags — one per
     *  registered repo that ships its own docker-compose.yml (#71). Same compose project,
     *  same env file, torn down together with the primary stack. */
    extraComposeFiles?: string[];
    cwd: string;
    projectName: string;
    envFile: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    /** Add `--force-recreate` so existing containers are recreated (the "rebuild" control, #92). */
    forceRecreate?: boolean;
  }): Promise<{ ok: boolean; stderr: string }>;
  down(args: {
    projectName: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Remove named volumes too (`-v`). Defaults to true — the teardown/reaper paths pass
     * nothing and keep the original destructive down. The user-initiated STOP control (#92)
     * passes `false` so a subsequent START finds its data intact.
     */
    removeVolumes?: boolean;
  }): Promise<{ ok: boolean; stderr: string }>;
  /** `docker compose restart` — bounce the running containers, reusing the same ports (#92). */
  restart(args: {
    composeFile: string;
    extraComposeFiles?: string[];
    projectName: string;
    cwd: string;
    envFile: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; stderr: string }>;
  /** `docker compose logs --tail N` — a BOUNDED, non-following tail (never hangs, #92). */
  logs(args: {
    composeFile: string;
    extraComposeFiles?: string[];
    projectName: string;
    cwd: string;
    envFile: string;
    tail: number;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** Compose project names currently known to the daemon (running or stopped). */
  list(env?: NodeJS.ProcessEnv): Promise<string[]>;
  /**
   * Compose project names carried by LABELED volumes/networks/images on the daemon —
   * container-less residue `list()` (container-derived `compose ls`) can never see: a
   * failed compensating down that removed containers but errored on the volume, or
   * containers pruned externally, leaves named volumes/networks/`--rmi local` images
   * behind with no container left to report the project (#163).
   */
  listResidualProjects(env?: NodeJS.ProcessEnv): Promise<string[]>;
  /**
   * Remove every volume/network/image labeled `com.docker.compose.project=<projectName>`
   * directly (not via `compose down -p`, which resolves the project from CONTAINER
   * labels — a project with no containers left cannot be downed by name at all, #163).
   */
  removeResidualProjectResources(projectName: string, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; stderr: string }>;
}

/** Heuristic: does a compose `up` stderr indicate a host/namespace port collision? */
export function isPortInUseError(stderr: string): boolean {
  return /port is already allocated|address already in use|bind for .* failed|ports are not available|failed to bind|Only one usage of each socket address/i.test(stderr);
}

/**
 * Default compose driver: shells out to `docker compose` through the docker-exec
 * adapter. Every method first checks `dockerAvailable()` so a host without docker
 * no-ops cleanly (up → ok:false with a clear message; list → []).
 */
export function createDefaultComposeRunner(): ComposeRunner {
  return {
    async up({ composeFile, extraComposeFiles, cwd, projectName, envFile, timeoutMs, env, forceRecreate }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host (service stack skipped)" };
      }
      const fileArgs = ["-f", composeFile, ...(extraComposeFiles ?? []).flatMap((f) => ["-f", f])];
      const upFlags = forceRecreate ? ["up", "-d", "--wait", "--force-recreate"] : ["up", "-d", "--wait"];
      const res = await dockerExec(
        ["compose", "-p", projectName, ...fileArgs, "--env-file", envFile, ...upFlags],
        { cwd, env, timeoutMs },
      );
      return { ok: execSucceeded(res), stderr: execErrorMessage(res) };
    },
    async down({ projectName, cwd, env, removeVolumes }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host" };
      }
      // Full teardown adds `--rmi local`: compose removes images it built itself
      // (a `build:`-context service with no `image:` field, auto-tagged
      // `<projectName>-<service>`) while leaving pull-based images (postgres, redis,
      // …, referenced by their custom `image:` name) untouched. Without it, every
      // workspace that provisions a build-context stack leaks a uniquely-named image
      // forever, since each workspace's compose project name is distinct (#106). The
      // volume-preserving stop path (removeVolumes === false) keeps the image so a
      // later restart is fast.
      const downFlags =
        removeVolumes === false
          ? ["down", "--remove-orphans"]
          : ["down", "-v", "--rmi", "local", "--remove-orphans"];
      const res = await dockerExec(["compose", "-p", projectName, ...downFlags], { cwd, env });
      return { ok: execSucceeded(res), stderr: execErrorMessage(res) };
    },
    async restart({ composeFile, extraComposeFiles, projectName, cwd, envFile, env, timeoutMs }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host" };
      }
      const fileArgs = ["-f", composeFile, ...(extraComposeFiles ?? []).flatMap((f) => ["-f", f])];
      const res = await dockerExec(
        ["compose", "-p", projectName, ...fileArgs, "--env-file", envFile, "restart"],
        { cwd, env, timeoutMs: timeoutMs ?? 120000 },
      );
      return { ok: execSucceeded(res), stderr: execErrorMessage(res) };
    },
    async logs({ composeFile, extraComposeFiles, projectName, cwd, envFile, tail, env, timeoutMs }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stdout: "", stderr: "docker is not available on this host" };
      }
      const safeTail = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 200;
      const fileArgs = ["-f", composeFile, ...(extraComposeFiles ?? []).flatMap((f) => ["-f", f])];
      // No `-f`/`--follow`: a bounded `--tail` returns immediately instead of streaming
      // forever (the acceptance criterion "returns a recent tail without hanging", #92).
      const res = await dockerExec(
        ["compose", "-p", projectName, ...fileArgs, "--env-file", envFile, "logs", "--no-color", "--tail", String(safeTail)],
        { cwd, env, timeoutMs: timeoutMs ?? 20000 },
      );
      return { ok: execSucceeded(res), stdout: res.stdout, stderr: execErrorMessage(res) };
    },
    async list(env) {
      if (!(await dockerAvailable(env))) return [];
      const res = await dockerExec(["compose", "ls", "--all", "--format", "json"], { env });
      if (!execSucceeded(res)) return [];
      try {
        const parsed: unknown = JSON.parse(res.stdout || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((entry) => (entry && typeof entry === "object" ? (entry as { Name?: unknown }).Name : undefined))
          .filter((name): name is string => typeof name === "string" && name.length > 0);
      } catch {
        return [];
      }
    },
    async listResidualProjects(env) {
      if (!(await dockerAvailable(env))) return [];
      const names = new Set<string>();
      const queries: string[][] = [
        ["volume", "ls", "--filter", `label=${COMPOSE_PROJECT_LABEL}`, "--format", `{{ index .Labels "${COMPOSE_PROJECT_LABEL}" }}`],
        ["network", "ls", "--filter", `label=${COMPOSE_PROJECT_LABEL}`, "--format", `{{ index .Labels "${COMPOSE_PROJECT_LABEL}" }}`],
        ["images", "--filter", `label=${COMPOSE_PROJECT_LABEL}`, "--format", `{{ index .Labels "${COMPOSE_PROJECT_LABEL}" }}`],
      ];
      for (const args of queries) {
        const res = await dockerExec(args, { env });
        if (!execSucceeded(res)) continue;
        for (const line of res.stdout.split("\n")) {
          const name = line.trim();
          if (name) names.add(name);
        }
      }
      return [...names];
    },
    async removeResidualProjectResources(projectName, env) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host" };
      }
      const filter = `label=${COMPOSE_PROJECT_LABEL}=${projectName}`;
      let ok = true;
      const stderrParts: string[] = [];
      const removeByKind = async (listArgs: string[], removeCmd: (ids: string[]) => string[]) => {
        const listRes = await dockerExec(listArgs, { env });
        if (!execSucceeded(listRes)) {
          ok = false;
          stderrParts.push(execErrorMessage(listRes));
          return;
        }
        const ids = listRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        if (ids.length === 0) return;
        const removeRes = await dockerExec(removeCmd(ids), { env });
        if (!execSucceeded(removeRes)) {
          ok = false;
          stderrParts.push(execErrorMessage(removeRes));
        }
      };
      await removeByKind(["volume", "ls", "-q", "--filter", filter], (ids) => ["volume", "rm", "-f", ...ids]);
      await removeByKind(["network", "ls", "-q", "--filter", filter], (ids) => ["network", "rm", ...ids]);
      await removeByKind(["images", "-q", "--filter", filter], (ids) => ["rmi", "-f", ...ids]);
      return { ok, stderr: stderrParts.filter(Boolean).join("; ") };
    },
  };
}

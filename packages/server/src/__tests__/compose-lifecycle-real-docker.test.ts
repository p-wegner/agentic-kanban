import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceStackConfig } from "@agentic-kanban/shared";
import { dockerExec, dockerAvailable } from "@agentic-kanban/shared/lib/docker-exec";
import { createWorkspaceServicesService } from "../services/workspace-services.service.js";
import { createStackPortAllocator } from "../services/port-allocator.js";

/**
 * The ONE real-docker regression test for the compose service-stack lifecycle (#164).
 *
 * Everything else exercising this engine (workspace-services.service.test.ts,
 * compose-runner-down-rmi.test.ts, ...) uses a FAKE ComposeRunner — they prove the
 * engine calls the compose CLI with the right flags, never that the flags actually do
 * what the comments claim against a real daemon. This test drives the real
 * `createDefaultComposeRunner()` against a tiny throwaway compose project covering
 * three previously "verified live once in a manual lab" claims in one pass:
 *  - `up -d --wait` health-gates on a real healthcheck and allocates a real host port,
 *  - `COMPOSE_PROFILES` written into the generated `--env-file` activates a
 *    profile-gated service with no `--profile` CLI flag,
 *  - `down -v --rmi local --remove-orphans` (label-scoped, `-p <project>`) leaves
 *    ZERO residue: no containers, no named volumes, no networks, and — the specific
 *    #106 regression — no locally-BUILT image for the compose project.
 *
 * Skipped (not failed) when docker is unavailable, so CI without docker stays green;
 * run explicitly via `pnpm test:docker` (excluded from the `test:mine` fast loop
 * since it shells out to a real daemon and pulls/builds real images).
 */

const hasDocker = await dockerAvailable();

const COMPOSE_YAML = `services:
  web:
    image: alpine:3.20
    command: ["sh", "-c", "nc -lk -p 80 -e /bin/true"]
    ports:
      - "\${KANBAN_SVC_WEB_PORT}:80"
    volumes:
      - data:/data
    healthcheck:
      test: ["CMD", "nc", "-z", "-w", "2", "localhost", "80"]
      interval: 2s
      timeout: 2s
      retries: 15
      start_period: 2s
  built:
    build:
      context: .
      dockerfile: Dockerfile.built
    command: ["sleep", "3600"]
  extra:
    image: alpine:3.20
    command: ["sleep", "3600"]
    profiles: ["extra"]
volumes:
  data:
`;

const DOCKERFILE_BUILT = `FROM alpine:3.20\n`;

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

async function labeledNames(kind: "ps" | "volume" | "network" | "images", projectName: string, extraArgs: string[] = []): Promise<string[]> {
  const base = kind === "ps" ? ["ps", "-a"] : kind === "images" ? ["images"] : [kind, "ls"];
  // `docker volume ls` has no `{{.ID}}` field (volumes are name-identified); every other
  // kind used here does.
  const idField = kind === "volume" ? "{{.Name}}" : "{{.ID}}";
  const res = await dockerExec([...base, "--filter", `label=${COMPOSE_PROJECT_LABEL}=${projectName}`, ...extraArgs, "--format", idField]);
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

describe.skipIf(!hasDocker)("real docker: compose service-stack lifecycle (#164)", () => {
  let worktree: string;
  const workspaceId = `164smoke${Date.now()}`;

  beforeAll(async () => {
    worktree = await mkdtemp(join(tmpdir(), "ak-docker-smoke-"));
    await writeFile(join(worktree, "docker-compose.yml"), COMPOSE_YAML, "utf-8");
    await writeFile(join(worktree, "Dockerfile.built"), DOCKERFILE_BUILT, "utf-8");
  });

  afterAll(async () => {
    if (worktree) await rm(worktree, { recursive: true, force: true }).catch(() => {});
  });

  it(
    "up -d --wait provisions a healthy, profile-activated stack with a port env var, and teardown leaves zero residue",
    async () => {
      const svc = createWorkspaceServicesService({
        getInstanceId: async () => "dksmoke1",
        markServiceStateDown: async () => {},
        findLiveStackReferences: async () => [],
        resolveExtraComposeFiles: async () => [],
        allocatePorts: createStackPortAllocator({ getInUsePorts: async () => [] }),
      });
      const config: ServiceStackConfig = {
        enabled: true,
        composeFile: "docker-compose.yml",
        ports: ["web"],
        profiles: ["extra"],
        readyTimeoutMs: 45000,
      };

      const state = await svc.provisionWorkspaceServices({
        config,
        workspaceId,
        composeWorktreePath: worktree,
      });
      expect(state.status, `provisioning failed: ${state.error ?? "(no error message)"}`).toBe("up");
      const projectName = state.composeProjectName;

      try {
        // Port allocated + exposed for the agent, both in the returned state and the
        // generated env file it sources.
        expect(state.ports.web).toBeGreaterThan(0);
        const envBody = await readFile(state.envFilePath, "utf-8");
        expect(envBody).toContain(`KANBAN_SVC_WEB_PORT='${state.ports.web}'`);
        // COMPOSE_PROFILES honored via --env-file (no --profile CLI flag anywhere).
        expect(envBody).toContain("COMPOSE_PROFILES='extra'");

        // `up --wait` health-gated: the healthcheck-bearing service reports healthy.
        const webStatus = await dockerExec([
          "ps",
          "--filter",
          `label=${COMPOSE_PROJECT_LABEL}=${projectName}`,
          "--filter",
          "label=com.docker.compose.service=web",
          "--format",
          "{{.Status}}",
        ]);
        expect(webStatus.stdout).toContain("healthy");

        // The profile-gated `extra` service was actually started (COMPOSE_PROFILES took
        // effect) alongside the unconditional `web` and `built` services.
        const runningIds = await labeledNames("ps", projectName, ["--filter", "status=running"]);
        expect(runningIds.length).toBe(3);
      } finally {
        await svc.teardownWorkspaceServices({
          composeProjectName: projectName,
          composeWorktreePath: worktree,
          releasedByWorkspaceId: workspaceId,
        });
      }

      // Zero residue: no containers, no named volumes, no networks, and — the #106
      // regression this stack specifically targets — no locally-built image left
      // behind for the `built` service (`--rmi local`). Pulled images (web/extra's
      // alpine:3.20) are never labeled with the compose project, so they're correctly
      // excluded from this check.
      expect(await labeledNames("ps", projectName)).toEqual([]);
      expect(await labeledNames("volume", projectName)).toEqual([]);
      expect(await labeledNames("network", projectName)).toEqual([]);
      expect(await labeledNames("images", projectName)).toEqual([]);
    },
    55000,
  );
});

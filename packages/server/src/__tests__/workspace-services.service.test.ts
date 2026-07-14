import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceServicesService,
  createDefaultComposeRunner,
  buildServicesEnvFile,
  type ComposeRunner,
} from "../services/workspace-services.service.js";
import type { ServiceStackConfig } from "@agentic-kanban/shared";
import { composeProjectName } from "@agentic-kanban/shared";

/** A fake ComposeRunner recording calls and returning scripted results. */
function makeFakeRunner(overrides: Partial<ComposeRunner> = {}): {
  runner: ComposeRunner;
  ups: Array<Parameters<ComposeRunner["up"]>[0]>;
  downs: Array<Parameters<ComposeRunner["down"]>[0]>;
} {
  const ups: Array<Parameters<ComposeRunner["up"]>[0]> = [];
  const downs: Array<Parameters<ComposeRunner["down"]>[0]> = [];
  const runner: ComposeRunner = {
    up: async (args) => {
      ups.push(args);
      return { ok: true, stderr: "" };
    },
    down: async (args) => {
      downs.push(args);
      return { ok: true, stderr: "" };
    },
    list: async () => [],
    ...overrides,
  };
  return { runner, ups, downs };
}

const CONFIG: ServiceStackConfig = {
  enabled: true,
  composeFile: "docker-compose.yml",
  ports: ["db", "cache"],
  readyTimeoutMs: 45000,
  env: { POSTGRES_PASSWORD: "secret" },
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ak-svc-test-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

describe("buildServicesEnvFile", () => {
  it("writes COMPOSE_PROJECT_NAME, KANBAN_STACK, named ports, config env, and extra env", () => {
    const body = buildServicesEnvFile({
      composeProjectName: "ak-abc12345-ws-7",
      ports: { db: 51000, cache: 51001 },
      config: CONFIG,
      extraEnv: { KANBAN_WORKTREE_BRANCH: "feature/ak-7-x" },
    });
    expect(body).toContain("COMPOSE_PROJECT_NAME=ak-abc12345-ws-7");
    expect(body).toContain("KANBAN_STACK=1");
    expect(body).toContain("KANBAN_SVC_DB_PORT=51000");
    expect(body).toContain("KANBAN_SVC_CACHE_PORT=51001");
    expect(body).toContain("POSTGRES_PASSWORD=secret");
    expect(body).toContain("KANBAN_WORKTREE_BRANCH=feature/ak-7-x");
    expect(body.endsWith("\n")).toBe(true);
  });
});

describe("provisionWorkspaceServices", () => {
  it("allocates ports, writes the env file, uses the deterministic project name, and calls up", async () => {
    const { runner, ups } = makeFakeRunner();
    const allocatePorts = async (names: string[]) =>
      Object.fromEntries(names.map((n, i) => [n, 60000 + i]));
    const svc = createWorkspaceServicesService({ runner, allocatePorts });

    const state = await svc.provisionWorkspaceServices({
      config: CONFIG,
      projectId: "Proj-XYZ-9999",
      offset: 42,
      composeWorktreePath: workDir,
    });

    const expectedName = composeProjectName("Proj-XYZ-9999", 42);
    expect(state.status).toBe("up");
    expect(state.composeProjectName).toBe(expectedName);
    expect(state.ports).toEqual({ db: 60000, cache: 60001 });
    expect(state.envFilePath).toBe(join(workDir, ".kanban", "services.env"));

    const written = await readFile(state.envFilePath, "utf-8");
    expect(written).toContain(`COMPOSE_PROJECT_NAME=${expectedName}`);
    expect(written).toContain("KANBAN_SVC_DB_PORT=60000");

    expect(ups).toHaveLength(1);
    expect(ups[0].projectName).toBe(expectedName);
    expect(ups[0].composeFile).toBe("docker-compose.yml");
    expect(ups[0].envFile).toBe(state.envFilePath);
    expect(ups[0].timeoutMs).toBe(45000);
    expect(ups[0].cwd).toBe(workDir);
  });

  it("returns an error state (not throwing) when compose up fails, still writing the env file", async () => {
    const { runner } = makeFakeRunner({
      up: async () => ({ ok: false, stderr: "postgres exited (1)" }),
    });
    const svc = createWorkspaceServicesService({ runner, allocatePorts: async () => ({}) });

    const state = await svc.provisionWorkspaceServices({
      config: { ...CONFIG, ports: [] },
      projectId: "p1",
      offset: 3,
      composeWorktreePath: workDir,
    });

    expect(state.status).toBe("error");
    expect(state.error).toContain("postgres exited");
    // Env file still written even though the stack failed to come up.
    const written = await readFile(join(workDir, ".kanban", "services.env"), "utf-8");
    expect(written).toContain("COMPOSE_PROJECT_NAME=");
  });

  it("skips port allocation when no ports are declared", async () => {
    let allocCalled = false;
    const { runner } = makeFakeRunner();
    const svc = createWorkspaceServicesService({
      runner,
      allocatePorts: async (names) => {
        allocCalled = true;
        return Object.fromEntries(names.map((n) => [n, 1]));
      },
    });
    const state = await svc.provisionWorkspaceServices({
      config: { ...CONFIG, ports: [] },
      projectId: "p1",
      offset: 1,
      composeWorktreePath: workDir,
    });
    expect(allocCalled).toBe(false);
    expect(state.ports).toEqual({});
  });
});

describe("teardownWorkspaceServices", () => {
  it("downs the deterministic compose project name and never throws", async () => {
    const { runner, downs } = makeFakeRunner();
    const svc = createWorkspaceServicesService({ runner });
    await svc.teardownWorkspaceServices({ projectId: "Proj-XYZ-9999", offset: 42, composeWorktreePath: workDir });
    expect(downs).toHaveLength(1);
    expect(downs[0].projectName).toBe(composeProjectName("Proj-XYZ-9999", 42));
  });

  it("swallows a runner failure", async () => {
    const svc = createWorkspaceServicesService({
      runner: makeFakeRunner({
        down: async () => {
          throw new Error("daemon gone");
        },
      }).runner,
    });
    await expect(
      svc.teardownWorkspaceServices({ projectId: "p", offset: 1, composeWorktreePath: workDir }),
    ).resolves.toBeUndefined();
  });
});

describe("reapOrphanServiceStacks", () => {
  it("downs managed stacks that no open workspace expects, leaving known + foreign ones", async () => {
    const known = composeProjectName("p1", 5);
    const orphan = composeProjectName("p1", 99);
    const { runner, downs } = makeFakeRunner({
      list: async () => [known, orphan, "some-unrelated-project"],
    });
    const svc = createWorkspaceServicesService({ runner });
    const { reaped } = await svc.reapOrphanServiceStacks({
      knownComposeProjectNames: new Set([known]),
    });
    expect(reaped).toEqual([orphan]);
    expect(downs.map((d) => d.projectName)).toEqual([orphan]);
  });
});

describe("default compose runner — docker-unavailable path", () => {
  // The default runner shells out to real `docker`. On a host without docker the
  // adapter's dockerAvailable() returns false and every method degrades cleanly.
  // (If docker IS installed in CI this still passes: up() may report ok:true/false
  // but never throws; list() returns an array.) We only assert non-throwing shape.
  it("up returns {ok:false} shape and list returns an array without throwing", async () => {
    const runner = createDefaultComposeRunner();
    const list = await runner.list();
    expect(Array.isArray(list)).toBe(true);
    const up = await runner.up({
      composeFile: "docker-compose.yml",
      cwd: workDir,
      projectName: "ak-test-ws-1",
      envFile: join(workDir, ".env"),
      timeoutMs: 3000,
    });
    expect(typeof up.ok).toBe("boolean");
    expect(typeof up.stderr).toBe("string");
  });
});

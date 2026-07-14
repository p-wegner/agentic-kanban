import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceServicesService,
  createDefaultComposeRunner,
  buildServicesEnvFile,
  parseStoredComposeProjectName,
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

const WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440000";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ak-svc-test-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

describe("buildServicesEnvFile", () => {
  it("writes COMPOSE_PROJECT_NAME, KANBAN_STACK, KANBAN_SERVICE_HOST, named ports, config env, and extra env", () => {
    const body = buildServicesEnvFile({
      composeProjectName: "ak-ws-abc12345def6",
      ports: { db: 51000, cache: 51001 },
      config: CONFIG,
      extraEnv: { KANBAN_WORKTREE_BRANCH: "feature/ak-7-x" },
      serviceHost: "host.docker.internal",
    });
    expect(body).toContain("COMPOSE_PROJECT_NAME=ak-ws-abc12345def6");
    expect(body).toContain("KANBAN_STACK=1");
    expect(body).toContain("KANBAN_SERVICE_HOST=host.docker.internal");
    expect(body).toContain("KANBAN_SVC_DB_PORT=51000");
    expect(body).toContain("KANBAN_SVC_CACHE_PORT=51001");
    expect(body).toContain("POSTGRES_PASSWORD=secret");
    expect(body).toContain("KANBAN_WORKTREE_BRANCH=feature/ak-7-x");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("defaults KANBAN_SERVICE_HOST to localhost when unset", () => {
    const prev = process.env.KANBAN_SERVICE_HOST;
    delete process.env.KANBAN_SERVICE_HOST;
    try {
      const body = buildServicesEnvFile({ composeProjectName: "ak-ws-abc123", ports: {}, config: { ...CONFIG, env: {} } });
      expect(body).toContain("KANBAN_SERVICE_HOST=localhost");
    } finally {
      if (prev !== undefined) process.env.KANBAN_SERVICE_HOST = prev;
    }
  });

  it("drops env entries whose value contains a CR/LF so the file is never broken (F11)", () => {
    const body = buildServicesEnvFile({
      composeProjectName: "ak-ws-abc123",
      ports: {},
      config: { ...CONFIG, env: { GOOD: "ok", EVIL: "x\nBAR=injected" } },
      extraEnv: { ALSO_EVIL: "y\r\nZAP=1" },
    });
    expect(body).toContain("GOOD=ok");
    expect(body).not.toContain("BAR=injected");
    expect(body).not.toContain("ZAP=1");
    // Exactly one line per legit key — no smuggled extra lines.
    expect(body.split("\n").filter((l) => l.startsWith("BAR=") || l.startsWith("ZAP="))).toHaveLength(0);
  });
});

describe("parseStoredComposeProjectName", () => {
  it("extracts the stored name and tolerates null/garbage", () => {
    expect(parseStoredComposeProjectName(JSON.stringify({ composeProjectName: "ak-ws-abc123def456" }))).toBe("ak-ws-abc123def456");
    expect(parseStoredComposeProjectName(null)).toBeNull();
    expect(parseStoredComposeProjectName("not json")).toBeNull();
    expect(parseStoredComposeProjectName(JSON.stringify({ ports: {} }))).toBeNull();
  });
});

describe("provisionWorkspaceServices", () => {
  it("allocates ports, writes the env file, uses the workspace-id-keyed project name, and calls up", async () => {
    const { runner, ups } = makeFakeRunner();
    const allocatePorts = async (names: string[]) =>
      Object.fromEntries(names.map((n, i) => [n, 60000 + i]));
    const svc = createWorkspaceServicesService({ runner, allocatePorts });

    const state = await svc.provisionWorkspaceServices({
      config: CONFIG,
      workspaceId: WORKSPACE_ID,
      composeWorktreePath: workDir,
    });

    const expectedName = composeProjectName(WORKSPACE_ID);
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
      workspaceId: "p1-abcdef",
      composeWorktreePath: workDir,
    });

    expect(state.status).toBe("error");
    expect(state.error).toContain("postgres exited");
    // Env file still written even though the stack failed to come up.
    const written = await readFile(join(workDir, ".kanban", "services.env"), "utf-8");
    expect(written).toContain("COMPOSE_PROJECT_NAME=");
  });

  it("runs a compensating down when up fails so partial containers don't linger (F5a)", async () => {
    const { runner, downs } = makeFakeRunner({
      up: async () => ({ ok: false, stderr: "dependency failed to start: container unhealthy" }),
    });
    const svc = createWorkspaceServicesService({ runner, allocatePorts: async () => ({}) });

    const state = await svc.provisionWorkspaceServices({
      config: { ...CONFIG, ports: [] },
      workspaceId: "ws-fail-1",
      composeWorktreePath: workDir,
    });

    expect(state.status).toBe("error");
    expect(downs).toHaveLength(1);
    expect(downs[0].projectName).toBe(composeProjectName("ws-fail-1"));
  });

  it("reallocates ports and retries up on a port-in-use failure (PORT-RETRY)", async () => {
    let upCalls = 0;
    const { runner, downs } = makeFakeRunner({
      up: async () => {
        upCalls += 1;
        return upCalls === 1
          ? { ok: false, stderr: 'Bind for 0.0.0.0:60000 failed: port is already allocated' }
          : { ok: true, stderr: "" };
      },
    });
    let allocCalls = 0;
    const allocatePorts = async (names: string[]) => {
      allocCalls += 1;
      const base = allocCalls === 1 ? 60000 : 61000;
      return Object.fromEntries(names.map((n, i) => [n, base + i]));
    };
    const svc = createWorkspaceServicesService({ runner, allocatePorts });

    const state = await svc.provisionWorkspaceServices({
      config: CONFIG,
      workspaceId: "ws-retry-1",
      composeWorktreePath: workDir,
    });

    expect(state.status).toBe("up");
    expect(upCalls).toBe(2);
    expect(allocCalls).toBe(2); // reallocated on retry
    expect(state.ports).toEqual({ db: 61000, cache: 61001 });
    // A best-effort down cleared partial containers before the retry.
    expect(downs.length).toBeGreaterThanOrEqual(1);
    // Env file reflects the retried (fresh) ports.
    const written = await readFile(state.envFilePath, "utf-8");
    expect(written).toContain("KANBAN_SVC_DB_PORT=61000");
  });

  it("does NOT retry a non-port failure", async () => {
    let upCalls = 0;
    const { runner } = makeFakeRunner({
      up: async () => {
        upCalls += 1;
        return { ok: false, stderr: "image not found" };
      },
    });
    const svc = createWorkspaceServicesService({ runner, allocatePorts: async (n) => Object.fromEntries(n.map((x, i) => [x, 60000 + i])) });
    const state = await svc.provisionWorkspaceServices({ config: CONFIG, workspaceId: "ws-noretry", composeWorktreePath: workDir });
    expect(state.status).toBe("error");
    expect(upCalls).toBe(1);
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
      workspaceId: "p1-noports",
      composeWorktreePath: workDir,
    });
    expect(allocCalled).toBe(false);
    expect(state.ports).toEqual({});
  });
});

describe("teardownWorkspaceServices", () => {
  it("downs the STORED compose project name and never throws", async () => {
    const { runner, downs } = makeFakeRunner();
    const svc = createWorkspaceServicesService({ runner });
    await svc.teardownWorkspaceServices({ composeProjectName: "ak-ws-stored123abc", composeWorktreePath: workDir });
    expect(downs).toHaveLength(1);
    expect(downs[0].projectName).toBe("ak-ws-stored123abc");
    expect(downs[0].cwd).toBe(workDir);
  });

  it("warns but does not throw when down reports ok:false (F6)", async () => {
    const { runner } = makeFakeRunner({ down: async () => ({ ok: false, stderr: "no such project" }) });
    const svc = createWorkspaceServicesService({ runner });
    await expect(
      svc.teardownWorkspaceServices({ composeProjectName: "ak-ws-abc123def", composeWorktreePath: workDir }),
    ).resolves.toBeUndefined();
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
      svc.teardownWorkspaceServices({ composeProjectName: "ak-ws-abc123def", composeWorktreePath: workDir }),
    ).resolves.toBeUndefined();
  });
});

describe("reapOrphanServiceStacks", () => {
  it("downs managed stacks that no open workspace expects, leaving known + foreign ones", async () => {
    const known = composeProjectName("known-ws-0001");
    const orphan = composeProjectName("orphan-ws-9999");
    const { runner, downs } = makeFakeRunner({
      list: async () => [known, orphan, "some-unrelated-project", "ak-myapp-ws-1"],
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
      projectName: "ak-ws-test1",
      envFile: join(workDir, ".env"),
      timeoutMs: 3000,
    });
    expect(typeof up.ok).toBe("boolean");
    expect(typeof up.stderr).toBe("string");
  });
});

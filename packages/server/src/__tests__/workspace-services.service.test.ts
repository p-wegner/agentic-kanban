import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceServicesService,
  createDefaultComposeRunner,
  buildServicesEnvFile,
  parseStoredComposeProjectName,
  parseStoredServiceStackState,
  type ComposeRunner,
} from "../services/workspace-services.service.js";
import type { ServiceStackConfig } from "@agentic-kanban/shared";
import { composeProjectName } from "@agentic-kanban/shared";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { createStackPortAllocator, releaseStackPorts } from "../services/port-allocator.js";

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

const INSTANCE = "testinst";

/**
 * Construct the engine with SAFE fakes for every DB-touching default (getInstanceId /
 * markServiceStateDown / findLiveStackReferences lazily hit the repository → real DB
 * when not injected).
 */
function makeService(deps: Parameters<typeof createWorkspaceServicesService>[0] = {}): {
  svc: ReturnType<typeof createWorkspaceServicesService>;
  markedDown: string[];
} {
  const markedDown: string[] = [];
  const svc = createWorkspaceServicesService({
    getInstanceId: async () => INSTANCE,
    markServiceStateDown: async (name) => {
      markedDown.push(name);
    },
    findLiveStackReferences: async () => [],
    ...deps,
  });
  return { svc, markedDown };
}

const CONFIG: ServiceStackConfig = {
  enabled: true,
  composeFile: "docker-compose.yml",
  ports: ["db", "cache"],
  readyTimeoutMs: 45000,
  env: { POSTGRES_PASSWORD: "secret" },
};

/** Single-port variant for the range-reservation-release test (one-port range). */
const CONFIG_1PORT: ServiceStackConfig = { ...CONFIG, ports: ["db"] };

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
      composeProjectName: "ak-testinst-ws-abc12345def6",
      ports: { db: 51000, cache: 51001 },
      config: CONFIG,
      extraEnv: { KANBAN_WORKTREE_BRANCH: "feature/ak-7-x" },
      serviceHost: "host.docker.internal",
    });
    expect(body).toContain("COMPOSE_PROJECT_NAME='ak-testinst-ws-abc12345def6'");
    expect(body).toContain("KANBAN_STACK='1'");
    expect(body).toContain("KANBAN_SERVICE_HOST='host.docker.internal'");
    expect(body).toContain("KANBAN_SVC_DB_PORT='51000'");
    expect(body).toContain("KANBAN_SVC_CACHE_PORT='51001'");
    expect(body).toContain("POSTGRES_PASSWORD='secret'");
    expect(body).toContain("KANBAN_WORKTREE_BRANCH='feature/ak-7-x'");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("defaults KANBAN_SERVICE_HOST to localhost when unset", () => {
    const prev = process.env.KANBAN_SERVICE_HOST;
    delete process.env.KANBAN_SERVICE_HOST;
    try {
      const body = buildServicesEnvFile({ composeProjectName: "ak-testinst-ws-abc123", ports: {}, config: { ...CONFIG, env: {} } });
      expect(body).toContain("KANBAN_SERVICE_HOST='localhost'");
    } finally {
      if (prev !== undefined) process.env.KANBAN_SERVICE_HOST = prev;
    }
  });

  it("single-quotes values so compose --env-file and shell sourcing read the SAME bytes (F12)", () => {
    // `$`, spaces and ` #` all diverge between the two parsers when unquoted; single
    // quotes are literal for both.
    const body = buildServicesEnvFile({
      composeProjectName: "ak-testinst-ws-abc123",
      ports: {},
      config: {
        ...CONFIG,
        env: {
          POSTGRES_PASSWORD: "pa$$word",
          JAVA_OPTS: "-Xmx512m -Xms256m",
          NOTE: "value with # hash",
        },
      },
    });
    expect(body).toContain("POSTGRES_PASSWORD='pa$$word'");
    expect(body).toContain("JAVA_OPTS='-Xmx512m -Xms256m'");
    expect(body).toContain("NOTE='value with # hash'");
  });

  it("drops env entries whose value contains a CR/LF so the file is never broken (F11)", () => {
    const body = buildServicesEnvFile({
      composeProjectName: "ak-testinst-ws-abc123",
      ports: {},
      config: { ...CONFIG, env: { GOOD: "ok", EVIL: "x\nBAR=injected" } },
      extraEnv: { ALSO_EVIL: "y\r\nZAP=1" },
    });
    expect(body).toContain("GOOD='ok'");
    expect(body).not.toContain("BAR=injected");
    expect(body).not.toContain("ZAP=1");
    // Exactly one line per legit key — no smuggled extra lines.
    expect(body.split("\n").filter((l) => l.startsWith("BAR=") || l.startsWith("ZAP="))).toHaveLength(0);
  });

  it("drops entries that cannot be represented identically for both parsers (quote in value, non-identifier key)", () => {
    const body = buildServicesEnvFile({
      composeProjectName: "ak-testinst-ws-abc123",
      ports: {},
      config: {
        ...CONFIG,
        env: {
          GOOD: "ok",
          QUOTED: "it's broken",
          "BAD-KEY": "aborts shell sourcing",
          "1LEADING": "not an identifier",
        },
      },
    });
    expect(body).toContain("GOOD='ok'");
    expect(body).not.toContain("QUOTED");
    expect(body).not.toContain("BAD-KEY");
    expect(body).not.toContain("1LEADING");
  });
});

describe("parseStoredComposeProjectName", () => {
  it("extracts the stored name and tolerates null/garbage", () => {
    expect(parseStoredComposeProjectName(JSON.stringify({ composeProjectName: "ak-testinst-ws-abc123def456" }))).toBe("ak-testinst-ws-abc123def456");
    expect(parseStoredComposeProjectName(null)).toBeNull();
    expect(parseStoredComposeProjectName("not json")).toBeNull();
    expect(parseStoredComposeProjectName(JSON.stringify({ ports: {} }))).toBeNull();
    expect(parseStoredComposeProjectName(JSON.stringify({ composeProjectName: "" }))).toBeNull();
  });
});

describe("parseStoredServiceStackState", () => {
  it("round-trips a full stored state and tolerates null/garbage/invalid shapes", () => {
    const stored = {
      composeProjectName: "ak-testinst-ws-abc123def456",
      ports: { db: 61000 },
      envFilePath: "C:/wt/.kanban/services.env",
      status: "up",
      updatedAt: new Date().toISOString(),
    };
    const parsed = parseStoredServiceStackState(JSON.stringify(stored));
    expect(parsed).not.toBeNull();
    expect(parsed!.composeProjectName).toBe(stored.composeProjectName);
    expect(parsed!.ports).toEqual({ db: 61000 });
    expect(parsed!.status).toBe("up");

    expect(parseStoredServiceStackState(null)).toBeNull();
    expect(parseStoredServiceStackState(undefined)).toBeNull();
    expect(parseStoredServiceStackState("not json")).toBeNull();
    expect(parseStoredServiceStackState(JSON.stringify({ composeProjectName: "x", status: "weird" }))).toBeNull();
    expect(parseStoredServiceStackState(JSON.stringify({ status: "up" }))).toBeNull();
  });
});

describe("provisionWorkspaceServices", () => {
  it("allocates ports, writes the env file, uses the instance+workspace-keyed project name, and calls up", async () => {
    const { runner, ups } = makeFakeRunner();
    const allocatePorts = async (names: string[]) =>
      Object.fromEntries(names.map((n, i) => [n, 60000 + i]));
    const { svc } = makeService({ runner, allocatePorts });

    const state = await svc.provisionWorkspaceServices({
      config: CONFIG,
      workspaceId: WORKSPACE_ID,
      composeWorktreePath: workDir,
    });

    const expectedName = composeProjectName(WORKSPACE_ID, INSTANCE);
    expect(state.status).toBe("up");
    expect(state.composeProjectName).toBe(expectedName);
    expect(state.ports).toEqual({ db: 60000, cache: 60001 });
    expect(state.envFilePath).toBe(join(workDir, ".kanban", "services.env"));

    const written = await readFile(state.envFilePath, "utf-8");
    expect(written).toContain(`COMPOSE_PROJECT_NAME='${expectedName}'`);
    expect(written).toContain("KANBAN_SVC_DB_PORT='60000'");

    expect(ups).toHaveLength(1);
    expect(ups[0].projectName).toBe(expectedName);
    expect(ups[0].composeFile).toBe("docker-compose.yml");
    expect(ups[0].envFile).toBe(state.envFilePath);
    expect(ups[0].timeoutMs).toBe(45000);
    expect(ups[0].cwd).toBe(workDir);
  });

  // #71 union port allocation: a compose that publishes a port the project never declared
  // in servicesConfig.ports still gets a free host port + env var allocated for it.
  it("discovers + allocates a port the primary compose references but config.ports omits", async () => {
    await writeFile(
      join(workDir, "docker-compose.yml"),
      [
        "services:",
        "  db:",
        "    image: postgres:16-alpine",
        "    ports: [\"${KANBAN_SVC_DB_PORT}:5432\"]",
        "  broker:",
        "    image: redis:7-alpine",
        "    ports: [\"${KANBAN_SVC_BROKER_PORT}:6379\"]",
        "",
      ].join("\n"),
      "utf-8",
    );
    const requested: string[][] = [];
    const allocatePorts = async (names: string[]) => {
      requested.push(names);
      return Object.fromEntries(names.map((n, i) => [n, 60000 + i]));
    };
    const { runner } = makeFakeRunner();
    const { svc } = makeService({ runner, allocatePorts, resolveExtraComposeFiles: async () => [] });

    const state = await svc.provisionWorkspaceServices({
      config: CONFIG, // declares db + cache only
      workspaceId: WORKSPACE_ID,
      composeWorktreePath: workDir,
    });

    // db + cache (declared) plus broker (discovered from the compose). cache is not in the
    // compose but stays declared; broker is unioned in, deduped by canonical env var.
    expect(requested[0]).toEqual(["db", "cache", "broker"]);
    expect(state.ports).toHaveProperty("broker");
    const written = await readFile(state.envFilePath, "utf-8");
    expect(written).toContain("KANBAN_SVC_BROKER_PORT=");
  });

  it("allocates ports for a sibling compose's own services and passes it as an extra -f (#71)", async () => {
    const siblingCompose = join(workDir, "sibling-compose.yml");
    await writeFile(
      siblingCompose,
      "services:\n  queue:\n    image: rabbitmq:3\n    ports: [\"${KANBAN_SVC_QUEUE_PORT}:5672\"]\n",
      "utf-8",
    );
    const requested: string[][] = [];
    const allocatePorts = async (names: string[]) => {
      requested.push(names);
      return Object.fromEntries(names.map((n, i) => [n, 60000 + i]));
    };
    const { runner, ups } = makeFakeRunner();
    const { svc } = makeService({ runner, allocatePorts, resolveExtraComposeFiles: async () => [siblingCompose] });

    await svc.provisionWorkspaceServices({
      config: CONFIG_1PORT, // declares db only
      workspaceId: WORKSPACE_ID,
      composeWorktreePath: workDir,
    });

    expect(requested[0]).toContain("queue");
    expect(ups[0].extraComposeFiles).toEqual([siblingCompose]);
  });

  it("writes a self-ignoring .kanban/.gitignore so the env file (secrets/ports) never enters git status", async () => {
    // Real git repo + LINKED WORKTREE — the exact context provisioning writes into.
    const repoDir = await mkdtemp(join(tmpdir(), "ak-svc-git-"));
    const wtParent = await mkdtemp(join(tmpdir(), "ak-svc-wt-"));
    const wtDir = join(wtParent, "wt");
    try {
      const git = async (args: string[], cwd: string) => {
        const res = await gitExec(args, { cwd });
        expect(res.code, `git ${args.join(" ")} failed: ${res.stderr}`).toBe(0);
        return res;
      };
      await git(["init"], repoDir);
      await writeFile(join(repoDir, "README.md"), "hello\n", "utf-8");
      await git(["add", "."], repoDir);
      await git(["-c", "user.email=test@test.local", "-c", "user.name=test", "commit", "-m", "init"], repoDir);
      await git(["worktree", "add", wtDir, "-b", "svc-sentinel-test"], repoDir);

      const { runner } = makeFakeRunner();
      const { svc } = makeService({ runner, allocatePorts: async () => ({ db: 60000 }) });
      const state = await svc.provisionWorkspaceServices({
        config: CONFIG,
        workspaceId: WORKSPACE_ID,
        composeWorktreePath: wtDir,
      });
      expect(state.status).toBe("up");

      // The env file exists (the check below must not pass vacuously) …
      await expect(readFile(state.envFilePath, "utf-8")).resolves.toContain("POSTGRES_PASSWORD");
      // … yet git sees NOTHING under .kanban/ — no diff/review leak, nothing an
      // agent's `git add -A` could commit.
      const status = await git(["status", "--porcelain", "--untracked-files=all"], wtDir);
      expect(status.stdout).not.toContain(".kanban");
    } finally {
      await gitExec(["worktree", "remove", "--force", wtDir], { cwd: repoDir }).catch(() => {});
      await rm(wtParent, { recursive: true, force: true }).catch(() => {});
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns an error state (not throwing) when compose up fails, still writing the env file", async () => {
    const { runner } = makeFakeRunner({
      up: async () => ({ ok: false, stderr: "postgres exited (1)" }),
    });
    const { svc } = makeService({ runner, allocatePorts: async () => ({}) });

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

  it("returns an error state when the instance id cannot be resolved (no unscoped fallback)", async () => {
    const { runner, ups } = makeFakeRunner();
    const svc = createWorkspaceServicesService({
      runner,
      allocatePorts: async () => ({}),
      getInstanceId: async () => {
        throw new Error("db unavailable");
      },
      markServiceStateDown: async () => {},
    });
    const state = await svc.provisionWorkspaceServices({
      config: { ...CONFIG, ports: [] },
      workspaceId: WORKSPACE_ID,
      composeWorktreePath: workDir,
    });
    expect(state.status).toBe("error");
    expect(state.error).toContain("instance id");
    expect(ups).toHaveLength(0);
  });

  it("runs a compensating down when up fails so partial containers don't linger (F5a)", async () => {
    const { runner, downs } = makeFakeRunner({
      up: async () => ({ ok: false, stderr: "dependency failed to start: container unhealthy" }),
    });
    const { svc } = makeService({ runner, allocatePorts: async () => ({}) });

    const state = await svc.provisionWorkspaceServices({
      config: { ...CONFIG, ports: [] },
      workspaceId: "ws-fail-1",
      composeWorktreePath: workDir,
    });

    expect(state.status).toBe("error");
    expect(downs).toHaveLength(1);
    expect(downs[0].projectName).toBe(composeProjectName("ws-fail-1", INSTANCE));
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
    const { svc } = makeService({ runner, allocatePorts });

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
    expect(written).toContain("KANBAN_SVC_DB_PORT='61000'");
  });

  it("releases the range reservation on success, so ports don't leak across provisions (#51)", async () => {
    // The REAL ranged allocator (registry-backed), not a fake — proves provision's
    // finally releases the reservation. Two sequential successful provisions on a
    // one-port range must BOTH get that port; if the first didn't release, the second
    // would fail to allocate.
    const range = { start: 45000, end: 45000 };
    const allocatePorts = createStackPortAllocator({ range });
    const { runner } = makeFakeRunner();
    const { svc } = makeService({ runner, allocatePorts });
    try {
      const first = await svc.provisionWorkspaceServices({ config: CONFIG_1PORT, workspaceId: "ws-a", composeWorktreePath: workDir });
      expect(first.status).toBe("up");
      expect(first.ports).toEqual({ db: 45000 });
      const second = await svc.provisionWorkspaceServices({ config: CONFIG_1PORT, workspaceId: "ws-b", composeWorktreePath: workDir });
      expect(second.status).toBe("up");
      expect(second.ports).toEqual({ db: 45000 }); // reused → the first was released
    } finally {
      releaseStackPorts([45000]);
    }
  });

  it("does NOT retry a non-port failure", async () => {
    let upCalls = 0;
    const { runner } = makeFakeRunner({
      up: async () => {
        upCalls += 1;
        return { ok: false, stderr: "image not found" };
      },
    });
    const { svc } = makeService({ runner, allocatePorts: async (n) => Object.fromEntries(n.map((x, i) => [x, 60000 + i])) });
    const state = await svc.provisionWorkspaceServices({ config: CONFIG, workspaceId: "ws-noretry", composeWorktreePath: workDir });
    expect(state.status).toBe("error");
    expect(upCalls).toBe(1);
  });

  it("skips port allocation when no ports are declared", async () => {
    let allocCalled = false;
    const { runner } = makeFakeRunner();
    const { svc } = makeService({
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
    const { svc } = makeService({ runner });
    await svc.teardownWorkspaceServices({ composeProjectName: "ak-testinst-ws-stored123abc", composeWorktreePath: workDir });
    expect(downs).toHaveLength(1);
    expect(downs[0].projectName).toBe("ak-testinst-ws-stored123abc");
    expect(downs[0].cwd).toBe(workDir);
  });

  it("marks the stored service state 'down' after a SUCCESSFUL down (stale-DTO fix)", async () => {
    const { runner } = makeFakeRunner();
    const { svc, markedDown } = makeService({ runner });
    await svc.teardownWorkspaceServices({ composeProjectName: "ak-testinst-ws-stored123abc", composeWorktreePath: workDir });
    expect(markedDown).toEqual(["ak-testinst-ws-stored123abc"]);
  });

  it("does NOT mark the state down when the down failed (containers may still run)", async () => {
    const { runner } = makeFakeRunner({ down: async () => ({ ok: false, stderr: "daemon busy" }) });
    const { svc, markedDown } = makeService({ runner });
    await expect(
      svc.teardownWorkspaceServices({ composeProjectName: "ak-testinst-ws-abc123def", composeWorktreePath: workDir }),
    ).resolves.toBeUndefined();
    expect(markedDown).toEqual([]);
  });

  it("swallows a runner failure", async () => {
    const { svc } = makeService({
      runner: makeFakeRunner({
        down: async () => {
          throw new Error("daemon gone");
        },
      }).runner,
    });
    await expect(
      svc.teardownWorkspaceServices({ composeProjectName: "ak-testinst-ws-abc123def", composeWorktreePath: workDir }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Shared-worktree last-reference guard (finding 12): co-resident workspaces (worktree
 * reuse / fork children) ADOPT one shared stack, so several live rows can reference the
 * same compose project. The down must only run when the RELEASING workspace is the last
 * live referent.
 */
describe("teardownWorkspaceServices — shared-stack last-reference guard", () => {
  const OWNER_ID = "550e8400-e29b-41d4-a716-446655440000"; // sanitizes to 550e8400e29b
  const ADOPTER_ID = "99998888-7777-6666-5555-444433332222";
  const STACK = composeProjectName(OWNER_ID, INSTANCE); // ak-testinst-ws-550e8400e29b

  it("skips the down (and does not mark the state down) while ANOTHER live workspace references the stack", async () => {
    const { runner, downs } = makeFakeRunner();
    const { svc, markedDown } = makeService({
      runner,
      findLiveStackReferences: async () => [{ id: ADOPTER_ID }],
    });
    await svc.teardownWorkspaceServices({
      composeProjectName: STACK,
      composeWorktreePath: workDir,
      releasedByWorkspaceId: OWNER_ID,
    });
    expect(downs).toHaveLength(0);
    expect(markedDown).toEqual([]);
  });

  it("downs the stack when the only live reference is the RELEASING workspace itself (last sharer)", async () => {
    const { runner, downs } = makeFakeRunner();
    const { svc, markedDown } = makeService({
      runner,
      findLiveStackReferences: async () => [{ id: ADOPTER_ID }],
    });
    await svc.teardownWorkspaceServices({
      composeProjectName: STACK,
      composeWorktreePath: workDir,
      releasedByWorkspaceId: ADOPTER_ID,
    });
    expect(downs).toHaveLength(1);
    expect(downs[0].projectName).toBe(STACK);
    expect(markedDown).toEqual([STACK]);
  });

  it("an ADOPTER releasing does NOT down the live OWNER's stack (#50)", async () => {
    // The adopter merges: its own row is already closed, so the only live referent is
    // the OWNER, whose agent is mid-ticket. The down must be skipped — `down -v` here
    // would destroy the owner's running containers AND its named volumes.
    const { runner, downs } = makeFakeRunner();
    const { svc, markedDown } = makeService({
      runner,
      findLiveStackReferences: async () => [{ id: OWNER_ID }],
    });
    await svc.teardownWorkspaceServices({
      composeProjectName: STACK,
      composeWorktreePath: workDir,
      releasedByWorkspaceId: ADOPTER_ID,
    });
    expect(downs).toHaveLength(0);
    expect(markedDown).toEqual([]);
  });

  it("the OWNER releasing with no other live referent downs its own stack", async () => {
    const { runner, downs } = makeFakeRunner();
    const { svc, markedDown } = makeService({
      runner,
      findLiveStackReferences: async () => [{ id: OWNER_ID }],
    });
    await svc.teardownWorkspaceServices({
      composeProjectName: STACK,
      composeWorktreePath: workDir,
      releasedByWorkspaceId: OWNER_ID,
    });
    expect(downs).toHaveLength(1);
    expect(markedDown).toEqual([STACK]);
  });

  it("skips the down when the sharer check fails (leak beats pulling a live shared stack)", async () => {
    const { runner, downs } = makeFakeRunner();
    const { svc, markedDown } = makeService({
      runner,
      findLiveStackReferences: async () => {
        throw new Error("db unavailable");
      },
    });
    await expect(
      svc.teardownWorkspaceServices({
        composeProjectName: STACK,
        composeWorktreePath: workDir,
        releasedByWorkspaceId: OWNER_ID,
      }),
    ).resolves.toBeUndefined();
    expect(downs).toHaveLength(0);
    expect(markedDown).toEqual([]);
  });
});

describe("reapOrphanServiceStacks", () => {
  it("downs THIS instance's orphans only — known, foreign-instance, legacy, and unrelated stacks are untouched", async () => {
    const known = composeProjectName("known-ws-0001", INSTANCE);
    const orphan = composeProjectName("orphan-ws-9999", INSTANCE);
    const otherInstanceLive = composeProjectName("other-boards-ws", "otherbrd");
    const legacyUnscoped = "ak-ws-legacy12345"; // pre-instance-id stack — owner unknowable
    const { runner, downs } = makeFakeRunner({
      list: async () => [known, orphan, otherInstanceLive, legacyUnscoped, "some-unrelated-project", "ak-myapp-ws-1"],
    });
    const { svc } = makeService({ runner });
    const { reaped } = await svc.reapOrphanServiceStacks({
      knownComposeProjectNames: new Set([known]),
    });
    expect(reaped).toEqual([orphan]);
    expect(downs.map((d) => d.projectName)).toEqual([orphan]);
  });

  it("reaps NOTHING when the instance id cannot be resolved (identity before destruction)", async () => {
    const { runner, downs } = makeFakeRunner({
      list: async () => [composeProjectName("some-ws-1", INSTANCE)],
    });
    const svc = createWorkspaceServicesService({
      runner,
      getInstanceId: async () => {
        throw new Error("db unavailable");
      },
      markServiceStateDown: async () => {},
    });
    const { reaped } = await svc.reapOrphanServiceStacks({ knownComposeProjectNames: new Set() });
    expect(reaped).toEqual([]);
    expect(downs).toHaveLength(0);
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
      projectName: "ak-testinst-ws-test1",
      envFile: join(workDir, ".env"),
      timeoutMs: 3000,
    });
    expect(typeof up.ok).toBe("boolean");
    expect(typeof up.stderr).toBe("string");
  });
});

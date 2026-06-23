import { describe, it, expect, vi } from "vitest";
import type { StackProfile } from "@agentic-kanban/shared";
import {
  resolveDevServerPlan,
  startDevServer,
  healthCheckDevServer,
  stopDevServer,
  devCommandPrefKey,
  healthUrlPrefKey,
} from "../services/dev-server.service.js";

function profile(overrides: Partial<StackProfile> = {}): StackProfile {
  return {
    stack: "node",
    packageManager: "pnpm",
    isMonorepo: false,
    workspaces: [],
    installCommand: "pnpm install",
    buildCommand: "pnpm build",
    testCommand: "pnpm test",
    quickTestCommand: "pnpm test",
    lintCommand: null,
    typecheckCommand: null,
    devCommand: "pnpm dev",
    isWeb: true,
    devHealthUrl: "http://localhost:5173",
    devPort: 5173,
    testDir: null,
    testRunner: "vitest",
    source: "detected",
    detectedMarkers: ["package.json"],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveDevServerPlan", () => {
  it("derives command, health URL and port from the stack profile", () => {
    const plan = resolveDevServerPlan({ profile: profile() });
    expect(plan).not.toBeNull();
    expect(plan!.command).toBe("pnpm dev");
    expect(plan!.healthUrl).toBe("http://localhost:5173");
    expect(plan!.port).toBe(5173);
    expect(plan!.isWeb).toBe(true);
    expect(plan!.source).toEqual({ command: "profile", healthUrl: "profile", port: "profile" });
  });

  it("returns null when there is no command to boot", () => {
    expect(resolveDevServerPlan({ profile: profile({ devCommand: null }) })).toBeNull();
    expect(resolveDevServerPlan({ profile: null })).toBeNull();
  });

  it("lets the dev_command pref override the profile command", () => {
    const plan = resolveDevServerPlan({
      profile: profile(),
      devCommandOverride: "uvicorn app:app --port 8000",
    });
    expect(plan!.command).toBe("uvicorn app:app --port 8000");
    expect(plan!.source.command).toBe("pref");
  });

  it("lets the health_url pref override the profile URL and drives the port from it", () => {
    const plan = resolveDevServerPlan({
      profile: profile(),
      healthUrlOverride: "http://127.0.0.1:8000/healthz",
    });
    expect(plan!.healthUrl).toBe("http://127.0.0.1:8000/healthz");
    expect(plan!.port).toBe(8000); // port follows the URL we actually probe
    expect(plan!.source.healthUrl).toBe("pref");
    expect(plan!.source.port).toBe("pref");
  });

  it("supports a non-web command (start it, but no health URL/port)", () => {
    const plan = resolveDevServerPlan({
      profile: profile({ devCommand: "python service.py", isWeb: false, devHealthUrl: null, devPort: null }),
    });
    expect(plan!.command).toBe("python service.py");
    expect(plan!.healthUrl).toBeNull();
    expect(plan!.port).toBeNull();
    expect(plan!.isWeb).toBe(false);
  });

  it("falls back to the app's worktree-port convention for health URL + port", () => {
    // No profile health URL/port; running in an ak-42 worktree -> 3043.
    const plan = resolveDevServerPlan({
      profile: profile({ devHealthUrl: null, devPort: null, isWeb: true }),
      workingDir: "C:/andrena/.worktrees/feature_ak-42-foo",
    });
    expect(plan!.healthUrl).toBe("http://127.0.0.1:3043/api/projects");
    expect(plan!.port).toBe(3043);
    expect(plan!.source.healthUrl).toBe("worktree-port");
    expect(plan!.source.port).toBe("worktree-port");
  });

  it("prefers profile health URL over the worktree convention", () => {
    const plan = resolveDevServerPlan({
      profile: profile(),
      workingDir: "C:/andrena/.worktrees/feature_ak-42-foo",
    });
    expect(plan!.healthUrl).toBe("http://localhost:5173");
    expect(plan!.source.healthUrl).toBe("profile");
  });

  it("resolves implicit http/https ports from the health URL", () => {
    const http = resolveDevServerPlan({
      profile: profile({ devPort: null }),
      healthUrlOverride: "http://example.test/health",
    });
    expect(http!.port).toBe(80);
    const https = resolveDevServerPlan({
      profile: profile({ devPort: null }),
      healthUrlOverride: "https://example.test/health",
    });
    expect(https!.port).toBe(443);
  });
});

describe("startDevServer", () => {
  it("spawns headless + detached + windowsHide with stdio to a log file", () => {
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ pid: 4242, unref })) as any;
    const openLog = vi.fn(() => 7);

    const result = startDevServer(
      { command: "pnpm dev", healthUrl: null, port: null, isWeb: true, source: { command: "profile", healthUrl: "none", port: "none" } },
      "C:/some/project",
      { logLabel: "proj-abc" },
      { spawnImpl, openLog },
    );

    expect(result.pid).toBe(4242);
    expect(result.command).toBe("pnpm dev");
    expect(unref).toHaveBeenCalled();
    expect(openLog).toHaveBeenCalled();

    const [command, opts] = spawnImpl.mock.calls[0];
    expect(command).toBe("pnpm dev");
    expect(opts.detached).toBe(true);
    expect(opts.cwd).toBe("C:/some/project");
    expect(opts.stdio).toEqual(["ignore", 7, 7]);
  });
});

describe("healthCheckDevServer", () => {
  it("returns ok on the first answer below 500", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 })) as any;
    const sleep = vi.fn(async () => {});
    const r = await healthCheckDevServer("http://x/health", { attempts: 5 }, { fetchImpl, sleep });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("treats a 404 as up (port bound, path just missing)", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 404 })) as any;
    const r = await healthCheckDevServer("http://x/health", { attempts: 3 }, { fetchImpl, sleep: vi.fn(async () => {}) });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(404);
  });

  it("retries through connection-refused then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return { status: 200 };
    }) as any;
    const sleep = vi.fn(async () => {});
    const r = await healthCheckDevServer("http://x/health", { attempts: 5, intervalMs: 50 }, { fetchImpl, sleep });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // between attempts only
    expect(r.waitedMs).toBe(100);
  });

  it("gives up after the attempt budget and reports the last error", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as any;
    const r = await healthCheckDevServer("http://x/health", { attempts: 3, intervalMs: 10 }, { fetchImpl, sleep: vi.fn(async () => {}) });
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.error).toContain("ECONNREFUSED");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps polling while the server returns 5xx", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return { status: calls < 2 ? 503 : 200 };
    }) as any;
    const r = await healthCheckDevServer("http://x/health", { attempts: 4 }, { fetchImpl, sleep: vi.fn(async () => {}) });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("stopDevServer", () => {
  it("kills only the resolved port's listener", async () => {
    const killPorts = vi.fn(async () => 1);
    const killed = await stopDevServer({ port: 8000 }, { killPorts });
    expect(killPorts).toHaveBeenCalledWith([8000]);
    expect(killed).toBe(1);
  });

  it("is a no-op when there is no port to target", async () => {
    const killPorts = vi.fn(async () => 0);
    const killed = await stopDevServer({ port: null }, { killPorts });
    expect(killPorts).not.toHaveBeenCalled();
    expect(killed).toBe(0);
  });
});

describe("preference keys", () => {
  it("are namespaced per project", () => {
    expect(devCommandPrefKey("p1")).toBe("dev_command_p1");
    expect(healthUrlPrefKey("p1")).toBe("health_url_p1");
  });
});

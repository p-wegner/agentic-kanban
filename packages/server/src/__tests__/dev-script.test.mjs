import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDrizzleFiles, findDrizzlePnpmDirs } from "../../../../scripts/drizzle-preflight.mjs";
import { checkSharedPackage, isTsxMissing, repairSharedIfNeeded } from "../../../../scripts/shared-preflight.mjs";
import { checkBinShims, repairBinShims } from "../../../../scripts/bin-shims-preflight.mjs";
import { buildDevPortEnv } from "../../../../scripts/dev-env.mjs";
import { resolveDevPorts } from "../../../../scripts/dev-port-plan.mjs";
import { buildBackendEnv, createStableDevProxy, listen, preferredInternalPort, resolvePublicServerPort } from "../../../../scripts/server-dev-proxy.mjs";
import {
  classifyProcessExit,
  createDependencyRecoveryState,
  createSharedDistRecoveryState,
  dependencyManifestsChanged,
  isStaleSharedDistError,
  listDependencyManifestFiles,
  MAX_SHARED_DIST_REBUILDS,
  snapshotDependencyManifests,
} from "../../../../scripts/dev-supervisor.mjs";
import { commandLineBelongsToCheckout, planPortOwnerKill } from "../../../../scripts/dev-port-guard.mjs";

function closeServer(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

function serverPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return address.port;
}

function requestText(port, path = "/health") {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolveRequest({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", rejectRequest);
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.end();
  });
}

function createBackend(label) {
  return createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(label);
  });
}

describe("dev launcher exit classification", () => {
  it("treats intentional exits and termination signals as clean", () => {
    expect(classifyProcessExit(0, null)).toBe("clean");
    expect(classifyProcessExit(null, "SIGINT")).toBe("clean");
    expect(classifyProcessExit(null, "SIGTERM")).toBe("clean");
  });

  it("keeps code 1 fatal because tsx watch handles hot reload internally", () => {
    expect(classifyProcessExit(1, null)).toBe("fatal");
  });

  it("retries unexpected nonfatal exit codes", () => {
    expect(classifyProcessExit(143, null)).toBe("retry");
    expect(classifyProcessExit(2, null)).toBe("retry");
  });

  it("detects dependency manifest changes while ignoring installed packages", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-dev-supervisor-"));
    try {
      mkdirSync(join(root, "packages", "server"), { recursive: true });
      mkdirSync(join(root, "node_modules", "some-package"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(join(root, "packages", "server", "package.json"), JSON.stringify({ dependencies: {} }));
      writeFileSync(join(root, "node_modules", "some-package", "package.json"), JSON.stringify({ name: "ignored" }));

      const before = snapshotDependencyManifests(root);
      expect(dependencyManifestsChanged(before, snapshotDependencyManifests(root))).toBe(false);
      expect(listDependencyManifestFiles(root).map((file) => file.replace(/\\/g, "/"))).not.toContain(
        join(root, "node_modules", "some-package", "package.json").replace(/\\/g, "/"),
      );

      writeFileSync(join(root, "packages", "server", "package.json"), JSON.stringify({ dependencies: { hono: "^4.0.0" } }));

      expect(dependencyManifestsChanged(before, snapshotDependencyManifests(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tracks dependency recovery generations for concurrent process exits", () => {
    const initialSnapshot = new Map([["package.json", "before"]]);
    const recovery = createDependencyRecoveryState(initialSnapshot);

    expect(recovery.snapshot).toBe(initialSnapshot);
    expect(recovery.generation).toBe(0);

    const recoveredSnapshot = new Map([["package.json", "after"]]);
    expect(recovery.markRecovered(recoveredSnapshot)).toBe(1);
    expect(recovery.snapshot).toBe(recoveredSnapshot);
    expect(recovery.generation).toBe(1);
  });
});

describe("server dev proxy", () => {
  it("keeps the public API port reachable while the watched backend restarts", async () => {
    let backend = createBackend("before-restart");
    let restartedBackend = null;
    let proxy = null;

    try {
      await listen(backend, 0);
      const backendPort = serverPort(backend);
      proxy = createStableDevProxy({
        publicPort: 0,
        backendPort,
        retryTimeoutMs: 2000,
        retryDelayMs: 25,
      });
      await listen(proxy, 0);
      const publicPort = serverPort(proxy);

      await expect(requestText(publicPort)).resolves.toMatchObject({
        status: 200,
        body: "before-restart",
      });

      await closeServer(backend);
      const duringRestart = requestText(publicPort);
      await new Promise((resolveRestart) => {
        setTimeout(async () => {
          restartedBackend = createBackend("after-restart");
          await listen(restartedBackend, backendPort);
          resolveRestart();
        }, 100);
      });

      await expect(duringRestart).resolves.toMatchObject({
        status: 200,
        body: "after-restart",
      });
    } finally {
      if (proxy) await closeServer(proxy).catch(() => {});
      if (backend.listening) await closeServer(backend).catch(() => {});
      if (restartedBackend?.listening) await closeServer(restartedBackend).catch(() => {});
    }
  });

  it("runs the watched server behind the stable proxy in package dev mode", () => {
    const serverPackageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(serverPackageJson.scripts.dev).toBe("node ../../scripts/server-dev-proxy.mjs");
  });

  it("keeps public board URLs separate from the watched backend listen port", () => {
    const publicPort = 3001;
    const internalPort = preferredInternalPort(publicPort);
    const env = buildBackendEnv({ PORT: String(publicPort) }, publicPort, internalPort);

    expect(env.KANBAN_INTERNAL_SERVER_PORT).toBe(String(internalPort));
    expect(env.KANBAN_SERVER_PORT).toBe(String(publicPort));
    expect(env.PORT).toBe(String(publicPort));
  });

  it("preserves worktree server port precedence for direct package dev launches", () => {
    const publicPort = resolvePublicServerPort({
      KANBAN_WORKTREE_SERVER_PORT: "3222",
      KANBAN_SERVER_PORT: "3001",
      SERVER_PORT: "3001",
      PORT: "3001",
    });
    const env = buildBackendEnv({
      KANBAN_WORKTREE_SERVER_PORT: "3222",
      KANBAN_SERVER_PORT: "3001",
      SERVER_PORT: "3001",
      PORT: "3001",
    }, publicPort, preferredInternalPort(publicPort));

    expect(publicPort).toBe(3222);
    expect(env.KANBAN_WORKTREE_SERVER_PORT).toBe("3222");
    expect(env.KANBAN_SERVER_PORT).toBe("3222");
    expect(env.SERVER_PORT).toBe("3222");
    expect(env.PORT).toBe("3222");
  });
});

describe("dev launcher port guard", () => {
  it("keeps the main checkout on the board server and client ports", () => {
    expect(resolveDevPorts({ isWorktree: false, branch: null })).toEqual({
      serverPort: 3001,
      clientPort: 5173,
      offset: 0,
    });
  });

  it("maps feature/ak-N worktrees onto deterministic isolated ports", () => {
    expect(resolveDevPorts({ isWorktree: true, branch: "feature/ak-229-regression-tests-for-worktree-port-isolati" })).toEqual({
      serverPort: 3230,
      clientPort: 5402,
      offset: 229,
    });
  });

  it("exports worktree server and client ports instead of default board ports", () => {
    const env = buildDevPortEnv(3222, 5394, {}, 12345);

    expect(env.PORT).toBe("3222");
    expect(env.SERVER_PORT).toBe("3222");
    expect(env.KANBAN_SERVER_PORT).toBe("3222");
    expect(env.KANBAN_WORKTREE_SERVER_PORT).toBe("3222");
    expect(env.VITE_PORT).toBe("5394");
    expect(env.KANBAN_CLIENT_PORT).toBe("5394");
    expect(env.KANBAN_WORKTREE_CLIENT_PORT).toBe("5394");
    expect(env.KANBAN_BOARD_SERVER_PID).toBe("12345");
    expect(env.PORT).not.toBe("3001");
    expect(env.VITE_PORT).not.toBe("5173");
  });

  it("allows freeing a default board port when the owner is from the same main checkout", () => {
    const auditEvents = [];
    const decision = planPortOwnerKill({
      pid: "3001",
      port: 3001,
      checkoutRoot: "C:\\andrena\\agentic-kanban",
      getCommandLine: () => "node C:\\andrena\\agentic-kanban\\node_modules\\tsx\\dist\\cli.mjs src/index.ts",
      audit: (event) => auditEvents.push(event),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("inside-checkout");
    expect(auditEvents).toContainEqual(expect.objectContaining({
      action: "dev-port-kill-allowed",
      port: 3001,
      pid: "3001",
      checkoutRoot: "C:\\andrena\\agentic-kanban",
    }));
  });

  it("allows freeing a worktree port when the owner is from the same worktree checkout", () => {
    const auditEvents = [];
    const decision = planPortOwnerKill({
      pid: "3230",
      port: 3230,
      checkoutRoot: "C:\\andrena\\.worktrees\\feature_ak-229-regression-tests-for-worktree-port-isolati",
      getCommandLine: () => "node C:\\andrena\\.worktrees\\feature_ak-229-regression-tests-for-worktree-port-isolati\\packages\\server\\src\\index.ts",
      audit: (event) => auditEvents.push(event),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("inside-checkout");
    expect(auditEvents).toContainEqual(expect.objectContaining({
      action: "dev-port-kill-allowed",
      port: 3230,
      pid: "3230",
      checkoutRoot: "C:\\andrena\\.worktrees\\feature_ak-229-regression-tests-for-worktree-port-isolati",
    }));
  });

  it("matches checkout paths on path boundaries", () => {
    expect(commandLineBelongsToCheckout(
      "node C:\\andrena\\.worktrees\\feature_ak-175-harden-board-shutdowns\\packages\\server\\src\\index.ts",
      "C:\\andrena\\.worktrees\\feature_ak-175-harden-board-shutdowns",
    )).toBe(true);
  });

  it("does not treat similarly prefixed checkout paths as the same checkout", () => {
    expect(commandLineBelongsToCheckout(
      "node C:\\andrena\\.worktrees\\feature_ak-175-harden-board-shutdowns-old\\packages\\server\\src\\index.ts",
      "C:\\andrena\\.worktrees\\feature_ak-175-harden-board-shutdowns",
    )).toBe(false);
  });

  it("refuses to kill port 3001 when the owner belongs to another checkout", () => {
    const auditEvents = [];
    const decision = planPortOwnerKill({
      pid: "4242",
      port: 3001,
      checkoutRoot: "C:\\andrena\\.worktrees\\feature_ak-175-harden-board-shutdowns",
      getCommandLine: () => "node C:\\andrena\\agentic-kanban\\node_modules\\tsx\\dist\\cli.mjs src/index.ts",
      audit: (event) => auditEvents.push(event),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("outside-checkout");
    expect(auditEvents).toContainEqual(expect.objectContaining({
      action: "dev-port-kill-blocked",
      port: 3001,
      pid: "4242",
      reason: "outside-checkout",
    }));
  });
});

describe("stale shared dist detection and recovery", () => {
  it("detects ERR_MODULE_NOT_FOUND referencing packages/shared/dist in stderr", () => {
    const stderr =
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/repo/packages/shared/dist/schema/index.js'\n" +
      "    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1039:15)";
    expect(isStaleSharedDistError(stderr)).toBe(true);
  });

  it("detects the dist/lib variant of the stale-shared-dist error", () => {
    const stderr = "Cannot find module '/repo/packages/shared/dist/lib/index.js'";
    expect(isStaleSharedDistError(stderr)).toBe(true);
  });

  it("detects errors with forward-slash path separators", () => {
    expect(isStaleSharedDistError("Cannot find module 'packages/shared/dist/schema/index.js'")).toBe(true);
  });

  it("does not false-positive on unrelated module-not-found errors", () => {
    expect(isStaleSharedDistError("Cannot find module 'react'")).toBe(false);
    expect(isStaleSharedDistError("Cannot find module '/repo/packages/server/dist/index.js'")).toBe(false);
    expect(isStaleSharedDistError("EADDRINUSE :::3001")).toBe(false);
    expect(isStaleSharedDistError("")).toBe(false);
  });

  it("allows rebuilding up to MAX_SHARED_DIST_REBUILDS times then stops", () => {
    const recovery = createSharedDistRecoveryState();

    expect(recovery.rebuilds).toBe(0);
    expect(recovery.canRebuild()).toBe(true);

    for (let i = 0; i < MAX_SHARED_DIST_REBUILDS; i++) {
      expect(recovery.canRebuild()).toBe(true);
      recovery.markRebuilt();
    }

    expect(recovery.rebuilds).toBe(MAX_SHARED_DIST_REBUILDS);
    expect(recovery.canRebuild()).toBe(false);
  });

  it("tracks rebuild count via markRebuilt", () => {
    const recovery = createSharedDistRecoveryState();
    expect(recovery.markRebuilt()).toBe(1);
    expect(recovery.rebuilds).toBe(1);
    expect(recovery.markRebuilt()).toBe(2);
    expect(recovery.rebuilds).toBe(2);
  });
});

describe("drizzle preflight check", () => {
  function makeDrizzleRoot(version = "drizzle-orm@0.45.2_@libsql+client@0.14.0") {
    const root = mkdtempSync(join(tmpdir(), "ak-drizzle-preflight-"));
    const drizzleDir = join(root, "node_modules", ".pnpm", version, "node_modules", "drizzle-orm");
    mkdirSync(join(drizzleDir, "libsql"), { recursive: true });
    writeFileSync(join(drizzleDir, "alias.js"), "");
    writeFileSync(join(drizzleDir, "errors.js"), "");
    writeFileSync(join(drizzleDir, "libsql", "index.js"), "");
    return { root, drizzleDir };
  }

  it("returns empty list when all critical files are present", () => {
    const { root } = makeDrizzleRoot();
    try {
      expect(checkDrizzleFiles(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns missing paths when libsql/index.js is absent", () => {
    const { root, drizzleDir } = makeDrizzleRoot();
    try {
      rmSync(join(drizzleDir, "libsql", "index.js"));
      const missing = checkDrizzleFiles(root);
      expect(missing.length).toBeGreaterThan(0);
      expect(missing.some((p) => p.includes("libsql"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns missing paths when alias.js is absent", () => {
    const { root, drizzleDir } = makeDrizzleRoot();
    try {
      rmSync(join(drizzleDir, "alias.js"));
      const missing = checkDrizzleFiles(root);
      expect(missing.some((p) => p.endsWith("alias.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports all missing files at once when multiple are absent", () => {
    const { root, drizzleDir } = makeDrizzleRoot();
    try {
      rmSync(join(drizzleDir, "alias.js"));
      rmSync(join(drizzleDir, "errors.js"));
      rmSync(join(drizzleDir, "libsql", "index.js"));
      expect(checkDrizzleFiles(root)).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty list when node_modules/.pnpm does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-drizzle-preflight-empty-"));
    try {
      expect(checkDrizzleFiles(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds drizzle-orm pnpm virtual-store dirs by prefix", () => {
    const { root } = makeDrizzleRoot("drizzle-orm@0.45.2_@libsql+client@0.14.0");
    try {
      const dirs = findDrizzlePnpmDirs(root);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toContain("drizzle-orm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores non-drizzle packages in .pnpm", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-drizzle-preflight-mixed-"));
    try {
      mkdirSync(join(root, "node_modules", ".pnpm", "hono@4.0.0", "node_modules"), { recursive: true });
      mkdirSync(join(root, "node_modules", ".pnpm", "drizzle-orm@0.45.2", "node_modules", "drizzle-orm", "libsql"), { recursive: true });
      writeFileSync(join(root, "node_modules", ".pnpm", "drizzle-orm@0.45.2", "node_modules", "drizzle-orm", "alias.js"), "");
      writeFileSync(join(root, "node_modules", ".pnpm", "drizzle-orm@0.45.2", "node_modules", "drizzle-orm", "errors.js"), "");
      writeFileSync(join(root, "node_modules", ".pnpm", "drizzle-orm@0.45.2", "node_modules", "drizzle-orm", "libsql", "index.js"), "");
      const dirs = findDrizzlePnpmDirs(root);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toContain("drizzle-orm@0.45.2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("shared-package preflight", () => {
  function makeHealthySharedRoot() {
    const root = mkdtempSync(join(tmpdir(), "ak-shared-preflight-"));
    const sharedDir = join(root, "packages", "shared");
    const drizzleDir = join(sharedDir, "drizzle");
    mkdirSync(drizzleDir, { recursive: true });
    writeFileSync(join(sharedDir, "package.json"), JSON.stringify({ name: "@agentic-kanban/shared" }));
    writeFileSync(join(drizzleDir, "0001_init.sql"), "-- init");
    return { root, sharedDir, drizzleDir };
  }

  it("reports healthy when package.json and drizzle SQL files are present", () => {
    const { root } = makeHealthySharedRoot();
    try {
      const result = checkSharedPackage(root);
      expect(result.missingFiles).toHaveLength(0);
      expect(result.drizzleEmpty).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a missing package.json", () => {
    const { root, sharedDir } = makeHealthySharedRoot();
    try {
      rmSync(join(sharedDir, "package.json"));
      const result = checkSharedPackage(root);
      expect(result.missingFiles.length).toBeGreaterThan(0);
      expect(result.missingFiles.some((f) => f.endsWith("package.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects an empty drizzle directory", () => {
    const { root, drizzleDir } = makeHealthySharedRoot();
    try {
      rmSync(join(drizzleDir, "0001_init.sql"));
      const result = checkSharedPackage(root);
      expect(result.drizzleEmpty).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a missing drizzle directory", () => {
    const { root, drizzleDir } = makeHealthySharedRoot();
    try {
      rmSync(drizzleDir, { recursive: true, force: true });
      const result = checkSharedPackage(root);
      expect(result.drizzleEmpty).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects both missing package.json and empty drizzle simultaneously", () => {
    const { root, sharedDir, drizzleDir } = makeHealthySharedRoot();
    try {
      rmSync(join(sharedDir, "package.json"));
      rmSync(join(drizzleDir, "0001_init.sql"));
      const result = checkSharedPackage(root);
      expect(result.missingFiles.length).toBeGreaterThan(0);
      expect(result.drizzleEmpty).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when packages/shared is healthy", () => {
    const { root } = makeHealthySharedRoot();
    try {
      let gitRestoreCalled = false;
      const repaired = repairSharedIfNeeded(root, {
        runGitRestore: () => { gitRestoreCalled = true; return true; },
        runPnpmInstallForce: () => {},
      });
      expect(repaired).toBe(false);
      expect(gitRestoreCalled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs git restore when package.json is missing", () => {
    const { root, sharedDir } = makeHealthySharedRoot();
    try {
      rmSync(join(sharedDir, "package.json"));
      const calls = [];
      repairSharedIfNeeded(root, {
        runGitRestore: (r) => { calls.push({ op: "git-restore", r }); return true; },
        runPnpmInstallForce: (r) => { calls.push({ op: "pnpm-force", r }); },
      });
      expect(calls.some((c) => c.op === "git-restore")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not run pnpm install --force when tsx is present after restore", () => {
    const { root, sharedDir } = makeHealthySharedRoot();
    try {
      rmSync(join(sharedDir, "package.json"));
      // Create a fake tsx binary so isTsxMissing returns false
      const binDir = join(root, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "tsx"), "");

      const calls = [];
      repairSharedIfNeeded(root, {
        runGitRestore: () => { calls.push("git-restore"); return true; },
        runPnpmInstallForce: () => { calls.push("pnpm-force"); },
      });
      expect(calls).toContain("git-restore");
      expect(calls).not.toContain("pnpm-force");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs pnpm install --force when tsx is missing after restore", () => {
    const { root, sharedDir } = makeHealthySharedRoot();
    try {
      rmSync(join(sharedDir, "package.json"));
      // No tsx binary exists → isTsxMissing returns true
      const calls = [];
      repairSharedIfNeeded(root, {
        runGitRestore: () => { calls.push("git-restore"); return true; },
        runPnpmInstallForce: () => { calls.push("pnpm-force"); },
      });
      expect(calls).toContain("git-restore");
      expect(calls).toContain("pnpm-force");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips pnpm install when git restore fails", () => {
    const { root, sharedDir } = makeHealthySharedRoot();
    try {
      rmSync(join(sharedDir, "package.json"));
      const calls = [];
      repairSharedIfNeeded(root, {
        runGitRestore: () => { calls.push("git-restore"); return false; },
        runPnpmInstallForce: () => { calls.push("pnpm-force"); },
      });
      expect(calls).toContain("git-restore");
      expect(calls).not.toContain("pnpm-force");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects tsx missing when neither root nor server .bin/tsx exist", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-tsx-missing-"));
    try {
      expect(isTsxMissing(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects tsx present when root .bin/tsx exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-tsx-present-"));
    try {
      const binDir = join(root, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "tsx"), "");
      expect(isTsxMissing(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects tsx present when server-local .bin/tsx exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-tsx-server-"));
    try {
      const serverBinDir = join(root, "packages", "server", "node_modules", ".bin");
      mkdirSync(serverBinDir, { recursive: true });
      writeFileSync(join(serverBinDir, "tsx"), "");
      expect(isTsxMissing(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bin shims preflight", () => {
  function makeHealthyShimsRoot({ platform = "linux" } = {}) {
    const root = mkdtempSync(join(tmpdir(), "ak-bin-shims-"));
    const ext = platform === "win32" ? ".cmd" : "";
    mkdirSync(join(root, "packages", "server", "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(root, "packages", "client", "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "packages", "server", "node_modules", ".bin", `tsx${ext}`), "");
    writeFileSync(join(root, "packages", "client", "node_modules", ".bin", `vite${ext}`), "");
    return root;
  }

  it("returns empty when all shims are present (linux)", () => {
    const root = makeHealthyShimsRoot({ platform: "linux" });
    try {
      expect(checkBinShims(root, { platform: "linux" })).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty when all shims are present (windows .cmd)", () => {
    const root = makeHealthyShimsRoot({ platform: "win32" });
    try {
      expect(checkBinShims(root, { platform: "win32" })).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects missing server tsx shim", () => {
    const root = makeHealthyShimsRoot({ platform: "linux" });
    try {
      rmSync(join(root, "packages", "server", "node_modules", ".bin", "tsx"));
      const missing = checkBinShims(root, { platform: "linux" });
      expect(missing.some((s) => s.label.includes("packages/server"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects missing client vite shim", () => {
    const root = makeHealthyShimsRoot({ platform: "linux" });
    try {
      rmSync(join(root, "packages", "client", "node_modules", ".bin", "vite"));
      const missing = checkBinShims(root, { platform: "linux" });
      expect(missing.some((s) => s.label.includes("vite"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects both package-local shims missing simultaneously", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-bin-shims-empty-"));
    try {
      expect(checkBinShims(root, { platform: "linux" })).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when all shims are healthy", () => {
    const root = makeHealthyShimsRoot({ platform: "linux" });
    try {
      const calls = [];
      const ok = repairBinShims(root, {
        runPnpmInstallForce: () => { calls.push("pnpm-force"); },
        platform: "linux",
      });
      expect(ok).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("calls pnpm install --force when a shim is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-bin-shims-repair-"));
    try {
      const calls = [];
      repairBinShims(root, {
        runPnpmInstallForce: (r) => {
          calls.push(r);
          // Simulate the shims being created by the forced install
          mkdirSync(join(r, "node_modules", ".bin"), { recursive: true });
          mkdirSync(join(r, "packages", "server", "node_modules", ".bin"), { recursive: true });
          mkdirSync(join(r, "packages", "client", "node_modules", ".bin"), { recursive: true });
          writeFileSync(join(r, "node_modules", ".bin", "tsx"), "");
          writeFileSync(join(r, "packages", "server", "node_modules", ".bin", "tsx"), "");
          writeFileSync(join(r, "packages", "client", "node_modules", ".bin", "vite"), "");
        },
        platform: "linux",
      });
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns true after successful forced reinstall", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-bin-shims-success-"));
    try {
      const ok = repairBinShims(root, {
        runPnpmInstallForce: (r) => {
          mkdirSync(join(r, "node_modules", ".bin"), { recursive: true });
          mkdirSync(join(r, "packages", "server", "node_modules", ".bin"), { recursive: true });
          mkdirSync(join(r, "packages", "client", "node_modules", ".bin"), { recursive: true });
          writeFileSync(join(r, "node_modules", ".bin", "tsx"), "");
          writeFileSync(join(r, "packages", "server", "node_modules", ".bin", "tsx"), "");
          writeFileSync(join(r, "packages", "client", "node_modules", ".bin", "vite"), "");
        },
        platform: "linux",
      });
      expect(ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false when shims are still missing after forced reinstall", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-bin-shims-fail-"));
    try {
      const ok = repairBinShims(root, {
        runPnpmInstallForce: () => { /* does not create shims */ },
        platform: "linux",
      });
      expect(ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the extension-less shim as present on Windows when .cmd is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ak-bin-shims-win-compat-"));
    try {
      mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
      mkdirSync(join(root, "packages", "server", "node_modules", ".bin"), { recursive: true });
      mkdirSync(join(root, "packages", "client", "node_modules", ".bin"), { recursive: true });
      // Write extension-less variants only (no .cmd)
      writeFileSync(join(root, "node_modules", ".bin", "tsx"), "");
      writeFileSync(join(root, "packages", "server", "node_modules", ".bin", "tsx"), "");
      writeFileSync(join(root, "packages", "client", "node_modules", ".bin", "vite"), "");
      expect(checkBinShims(root, { platform: "win32" })).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

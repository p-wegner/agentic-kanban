import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDevPortEnv } from "../../../../scripts/dev-env.mjs";
import {
  classifyProcessExit,
  createDependencyRecoveryState,
  dependencyManifestsChanged,
  listDependencyManifestFiles,
  snapshotDependencyManifests,
} from "../../../../scripts/dev-supervisor.mjs";
import { commandLineBelongsToCheckout, planPortOwnerKill } from "../../../../scripts/dev-port-guard.mjs";

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

describe("dev launcher port guard", () => {
  it("exports worktree server and client ports instead of default board ports", () => {
    const env = buildDevPortEnv(3222, 5394, {}, 12345);

    expect(env.PORT).toBe("3222");
    expect(env.SERVER_PORT).toBe("3222");
    expect(env.KANBAN_SERVER_PORT).toBe("3222");
    expect(env.VITE_PORT).toBe("5394");
    expect(env.KANBAN_CLIENT_PORT).toBe("5394");
    expect(env.KANBAN_BOARD_SERVER_PID).toBe("12345");
    expect(env.PORT).not.toBe("3001");
    expect(env.VITE_PORT).not.toBe("5173");
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

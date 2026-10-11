// #1369: doctor prerequisites, committer identity on the worker, package managers in placement.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkGitIdentity,
  checkGitInstalled,
  checkGitSafeDirectory,
  checkPackageManager,
  parseGitVersion,
  type ProbeFn,
} from "../cli/commands/worker-doctor-git-prereqs.js";
import { applyCommitterIdentity } from "../worker/worker-repo.js";
import { detectPackageManagers } from "../worker/worker-toolchain.js";
import { missingPackageManagerNotes, requiredPackageManagerFor } from "../services/placement-package-manager.js";
import {
  packageManagerForLockfiles,
  parseBoardToWorkerMessage,
  parseWorkerCapabilities,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";

const probeOf = (table: Record<string, { code?: number; output: string } | null>): ProbeFn =>
  async (_cmd, args) => {
    const hit = table[args.join(" ")];
    return hit === null || hit === undefined ? { found: true, code: 1, output: "" } : { found: true, code: hit.code ?? 0, output: hit.output };
  };

describe("worker doctor prerequisites (#1369)", () => {
  it("parses git versions", () => {
    expect(parseGitVersion("git version 2.30.0.windows.1")).toEqual([2, 30]);
    expect(parseGitVersion("nonsense")).toBeNull();
  });

  it("fails git 2.30 with an upgrade command, passes 2.31+", async () => {
    const old = await checkGitInstalled(probeOf({ "--version": { output: "git version 2.30.2" } }), "win32");
    expect(old.status).toBe("fail");
    expect(old.remedy).toContain("winget");
    const ok = await checkGitInstalled(probeOf({ "--version": { output: "git version 2.31.0" } }), "linux");
    expect(ok.status).toBe("pass");
  });

  it("fails when git is missing", async () => {
    const res = await checkGitInstalled(async () => ({ found: false, code: null, output: "" }), "linux");
    expect(res.status).toBe("fail");
  });

  it("warns when there is no global identity, passes when there is", async () => {
    const none = await checkGitIdentity(probeOf({}));
    expect(none.status).toBe("warn");
    expect(none.remedy).toContain("git config --global user.name");
    const have = await checkGitIdentity(
      probeOf({ "config --global user.name": { output: "A" }, "config --global user.email": { output: "a@b.c" } }),
    );
    expect(have.status).toBe("pass");
  });

  it("notes a global safe.directory=* as INFO (pass), and nothing otherwise", async () => {
    const star = await checkGitSafeDirectory(probeOf({ "config --global --get-all safe.directory": { output: "/x\n*" } }));
    expect(star?.status).toBe("pass");
    expect(star?.detail).toContain("INFO");
    expect(await checkGitSafeDirectory(probeOf({}))).toBeNull();
  });

  it("warns with the corepack/npm hint when pnpm is absent", async () => {
    const res = await checkPackageManager(async () => ({ pnpm: false, yarn: false, bun: false, corepack: true }));
    expect(res.status).toBe("warn");
    expect(res.remedy).toContain("corepack enable pnpm");
    expect(res.remedy).toContain("npm i -g pnpm");
    expect((await checkPackageManager(async () => ({ pnpm: true, yarn: false, bun: false, corepack: false }))).status).toBe("pass");
  });
});

describe("package manager reporting + placement (#1369)", () => {
  it("detects each manager through the injected probe", async () => {
    const found = await detectPackageManagers(async (c) => c === "pnpm" || c === "corepack");
    expect(found).toEqual({ pnpm: true, yarn: false, bun: false, corepack: true });
  });

  it("round-trips through the capabilities parser, dropping malformed blobs", () => {
    const good = parseWorkerCapabilities({ packageManagers: { pnpm: true, yarn: false, bun: false, corepack: true } });
    expect(good?.packageManagers?.pnpm).toBe(true);
    expect(parseWorkerCapabilities({ packageManagers: { pnpm: "yes" } })).toBeUndefined();
  });

  it("maps lockfiles to a manager (npm needs none)", () => {
    expect(packageManagerForLockfiles(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(packageManagerForLockfiles(["yarn.lock"])).toBe("yarn");
    expect(packageManagerForLockfiles(["bun.lock"])).toBe("bun");
    expect(packageManagerForLockfiles(["package-lock.json"])).toBeNull();
  });

  it("explain names the worker and the missing manager, with the fix", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-1369-"));
    try {
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      const required = requiredPackageManagerFor(dir);
      expect(required).toBe("pnpm");
      const notes = missingPackageManagerNotes(required, [
        { name: "w1", packageManagers: { pnpm: false, yarn: true, bun: false, corepack: true } },
        { name: "w2", packageManagers: { pnpm: true, yarn: false, bun: false, corepack: false } },
        { name: "w3" },
      ]);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("w1");
      expect(notes[0]).toContain("pnpm");
      expect(notes[0]).toContain("corepack enable pnpm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("committer identity (#1369)", () => {
  it("parses the committer off an assignment and drops a half identity", () => {
    const msg = (committer: unknown) =>
      parseBoardToWorkerMessage({
        type: "assign",
        sessionId: "s",
        spec: { command: "c", cwd: "/x", args: [] },
        repo: { projectId: "p", gitPort: 1, gitToken: "t", branch: "b", baseBranch: "m", incomingRef: "r", committer },
      });
    const full = msg({ name: "Board", email: "board@example.com" });
    expect(full?.type === "assign" && full.repo?.committer).toEqual({ name: "Board", email: "board@example.com" });
    const half = msg({ name: "Board" });
    expect(half?.type === "assign" && half.repo?.committer).toBeUndefined();
  });

  it("sets a local identity only for the key the checkout lacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "id-1369-"));
    const env = { GIT_CONFIG_GLOBAL: join(dir, "nonexistent-global"), GIT_CONFIG_NOSYSTEM: "1" };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      await gitExecOrThrow(["init", dir], { cwd: dir });
      await gitExecOrThrow(["config", "--local", "user.name", "Existing"], { cwd: dir });
      await applyCommitterIdentity(dir, { name: "Board", email: "board@example.com" }, () => {});
      expect((await gitExec(["config", "user.name"], { cwd: dir })).stdout.trim()).toBe("Existing");
      expect((await gitExec(["config", "user.email"], { cwd: dir })).stdout.trim()).toBe("board@example.com");
      // a no-identity assignment (older board) changes nothing and does not throw
      await applyCommitterIdentity(dir, undefined, () => {});
    } finally {
      process.env = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

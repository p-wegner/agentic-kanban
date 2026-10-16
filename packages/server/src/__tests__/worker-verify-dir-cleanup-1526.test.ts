import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerifyJobFrame } from "@agentic-kanban/shared/lib/worker-verify-protocol";
import { removeDir, sweepVerifyBackstop, writeVerifyJobFile, VERIFY_JOB_FILE } from "../worker/worker-verify-runner.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const makeRoot = (): string => { const r = mkdtempSync(join(tmpdir(), "verify-1526-")); roots.push(r); return r; };

describe("#1526 verify dir cleanup", () => {
  it("removes a dir and reports null", () => {
    const root = makeRoot();
    const d = join(root, "a"); mkdirSync(join(d, "node_modules"), { recursive: true });
    writeFileSync(join(d, "node_modules", "x.txt"), "x");
    expect(removeDir(d)).toBeNull();
    expect(existsSync(d)).toBe(false);
  });

  it("does not follow a link into its target", () => {
    const root = makeRoot();
    const target = join(root, "store"); mkdirSync(target); writeFileSync(join(target, "keep.txt"), "k");
    const d = join(root, "a"); mkdirSync(d);
    try { symlinkSync(target, join(d, "link"), "junction"); } catch { return; }
    expect(removeDir(d)).toBeNull();
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  it("writes job.json naming the job", () => {
    const d = makeRoot();
    writeVerifyJobFile(d, { jobId: "j1", sha: "abc", kind: "train-gate", tier: "full", branch: "train/1" } as VerifyJobFrame, "2026-10-16T00:00:00.000Z");
    expect(JSON.parse(readFileSync(join(d, VERIFY_JOB_FILE), "utf8"))).toMatchObject({ jobId: "j1", kind: "train-gate", sha: "abc", branch: "train/1", startedAt: "2026-10-16T00:00:00.000Z" });
  });

  it("backstop removes old and over-count dirs but spares running ones", () => {
    const root = makeRoot();
    const now = Date.now();
    for (const [name, ageH] of [["old", 10], ["new1", 1], ["new2", 2], ["busy", 20]] as const) {
      const p = join(root, "verify", name); mkdirSync(p, { recursive: true });
      const t = new Date(now - ageH * 3_600_000); utimesSync(p, t, t);
    }
    const reaped = sweepVerifyBackstop(root, new Set(["busy"]), () => undefined, { maxCount: 1, nowMs: now });
    expect(reaped.sort()).toEqual(["new2", "old"]);
    expect(existsSync(join(root, "verify", "busy"))).toBe(true);
    expect(existsSync(join(root, "verify", "new1"))).toBe(true);
  });
});

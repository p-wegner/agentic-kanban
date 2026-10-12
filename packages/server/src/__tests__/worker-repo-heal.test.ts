// #1417 — a corrupt cached clone is moved aside and re-cloned once; doctor fscks the clones.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmOrReportHolder } from "./helpers/rm-or-report-holder.js";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { isCloneCorruption, quarantineCorruptClone, findCorruptClones } from "../worker/worker-repo-heal.js";

describe("isCloneCorruption", () => {
  it("matches the corruption signatures and not transport errors", () => {
    expect(isCloneCorruption("error: object file .git/objects/91/5c84 is empty")).toBe(true);
    expect(isCloneCorruption("error: loose object abc is corrupt")).toBe(true);
    expect(isCloneCorruption("fatal: bad object refs/remotes/origin/x")).toBe(true);
    expect(isCloneCorruption("fatal: could not read Username for 'http://h'")).toBe(false);
    expect(isCloneCorruption("fatal: unable to access: Connection refused")).toBe(false);
  });
});

describe("corrupt clone handling", () => {
  let workRoot: string;
  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), "ak-worker-heal-"));
  });
  afterEach(async () => {
    await rmOrReportHolder(workRoot);
  });

  it("quarantines the clone outside repos/ and keeps its contents", () => {
    const cacheDir = join(workRoot, "repos", "proj-1");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "marker"), "x");
    const aside = quarantineCorruptClone(workRoot, cacheDir, 42);
    expect(existsSync(cacheDir)).toBe(false);
    expect(aside).toBe(join(workRoot, "quarantine", "proj-1-42"));
    expect(existsSync(join(aside, "marker"))).toBe(true);
  });

  it("fsck flags a clone with an empty loose object and passes a sound one", async () => {
    const good = join(workRoot, "repos", "good");
    const badDir = join(workRoot, "repos", "bad");
    for (const dir of [good, badDir]) {
      mkdirSync(dir, { recursive: true });
      await gitExecOrThrow(["init", "-b", "master", dir], {});
      writeFileSync(join(dir, "f"), "hi\n");
      await gitExecOrThrow(["add", "."], { cwd: dir });
      await gitExecOrThrow(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "i"], { cwd: dir });
    }
    const blob = (await gitExec(["rev-parse", "HEAD^{tree}"], { cwd: badDir })).stdout.trim();
    const obj = join(badDir, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    rmSync(obj, { force: true });
    writeFileSync(obj, ""); // zero-byte loose object: the #1417 shape
    const found = await findCorruptClones(workRoot);
    expect(found.map((c) => c.project)).toEqual(["bad"]);
  });
});

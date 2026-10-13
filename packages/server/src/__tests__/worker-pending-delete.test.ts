import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPendingDeletes,
  recordPendingDelete,
  removeCheckoutDir,
  sweepPendingDeletes,
} from "../worker/worker-pending-delete.js";

const roots: string[] = [];
function mk(): string {
  const r = mkdtempSync(join(tmpdir(), "ak-pending-delete-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("worker pending deletes (#1445)", () => {
  it("removes a checkout directory outright", async () => {
    const root = mk();
    const dir = join(root, "checkouts", "s1", "node_modules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.node"), "x");
    expect(await removeCheckoutDir(root, join(root, "checkouts", "s1"), () => {})).toBe(true);
    expect(existsSync(join(root, "checkouts", "s1"))).toBe(false);
    expect(loadPendingDeletes(root)).toEqual([]);
  });

  it("a queued directory is deleted by the next sweep and leaves the list", async () => {
    const root = mk();
    const dir = join(root, "checkouts", "s2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "locked.node"), "x");
    expect(recordPendingDelete(root, dir, "EBUSY")).toBe(true);
    recordPendingDelete(root, dir, "EBUSY");
    const listed = loadPendingDeletes(root);
    expect(listed).toHaveLength(1);
    expect(listed[0].attempts).toBe(2);

    const report = await sweepPendingDeletes(root);
    expect(report.deleted).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    expect(loadPendingDeletes(root)).toEqual([]);
  });

  it("an already-gone directory is simply cleared from the list", async () => {
    const root = mk();
    recordPendingDelete(root, join(root, "checkouts", "gone"), "EBUSY");
    const report = await sweepPendingDeletes(root);
    expect(report.deleted).toHaveLength(1);
    expect(loadPendingDeletes(root)).toEqual([]);
  });
});

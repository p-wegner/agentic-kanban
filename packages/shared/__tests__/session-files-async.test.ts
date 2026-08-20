/**
 * perf(G1) — async twins in session-files: full async read + metadata-only stat
 * probe (the /output route's pre-read ETag inputs).
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import {
  sessionOutputPath,
  readSessionStdoutFileAsync,
  statSessionStdoutFile,
} from "../src/lib/session-files.js";

const createdFiles: string[] = [];
afterEach(() => {
  for (const f of createdFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

function writeOut(sessionId: string, content: string): string {
  const p = sessionOutputPath(sessionId);
  writeFileSync(p, content, "utf-8");
  createdFiles.push(p);
  return p;
}

describe("readSessionStdoutFileAsync", () => {
  it("reads the whole file", async () => {
    const sid = `sf-async-${process.pid}-${Date.now()}`;
    writeOut(sid, "line1\nline2\n");
    expect(await readSessionStdoutFileAsync(sid)).toBe("line1\nline2\n");
  });

  it("returns null for an absent or empty file", async () => {
    expect(await readSessionStdoutFileAsync(`sf-absent-${Date.now()}`)).toBeNull();
    const sid = `sf-empty-${process.pid}-${Date.now()}`;
    writeOut(sid, "");
    expect(await readSessionStdoutFileAsync(sid)).toBeNull();
  });
});

describe("statSessionStdoutFile", () => {
  it("returns size and mtime without reading content", async () => {
    const sid = `sf-stat-${process.pid}-${Date.now()}`;
    writeOut(sid, "0123456789");
    const stat = await statSessionStdoutFile(sid);
    expect(stat).not.toBeNull();
    expect(stat!.size).toBe(10);
    expect(stat!.mtimeMs).toBeGreaterThan(0);
  });

  it("returns null when the file is absent", async () => {
    expect(await statSessionStdoutFile(`sf-stat-absent-${Date.now()}`)).toBeNull();
  });
});

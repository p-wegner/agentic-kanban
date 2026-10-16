/**
 * #1520: keep Windows Search out of the worker's data dirs. Every checkout, verify dir, `pnpm install`
 * tree and temp fixture the worker creates was being content-indexed; SearchIndexer.exe dominated disk
 * I/O (131.6 MB per 30 s vs Defender 6.3 MB) and a DB-heavy package took 25 min instead of 105 s.
 *
 * The fix is FILE_ATTRIBUTE_NOT_CONTENT_INDEXED (`attrib +I`) on the directory: no admin, reversible
 * (`attrib -I`), and new subdirs inherit it. Applied at `worker start`; `worker doctor` reports a dir
 * that is still indexed. Defender exclusions are deliberately NOT touched (admin + security trade-off).
 * Windows only; every function is a no-op elsewhere. Failures are never fatal.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorCheck } from "../cli/commands/worker-doctor.js";

export type AttribRunner = (args: string[]) => Promise<{ ok: boolean; output: string }>;

const runAttrib: AttribRunner = (args) =>
  new Promise((resolve) => {
    execFile("attrib", args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => resolve({ ok: !err, output: String(stdout ?? "") }));
  });

/** The dirs the worker writes into: its home data dir (worker, checkouts, verify, repos, versions, harness), the work root, and temp. */
export function workerDataDirs(workRoot?: string, home: string = homedir(), temp: string = tmpdir()): string[] {
  return [...new Set([join(home, ".agentic-kanban"), ...(workRoot ? [workRoot] : []), temp])];
}

/** `attrib` prints `<flags> <path>`; the flag column carries `I` when the entry is not content indexed. */
export function parseNotIndexed(attribOutput: string, dir: string): boolean | null {
  const line = attribOutput.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith(dir.toLowerCase()));
  if (!line) return null;
  const flags = line.slice(0, line.toLowerCase().lastIndexOf(dir.toLowerCase()));
  return /\bI\b/.test(flags);
}

/** Existing dirs that are still content indexed. */
export async function findIndexedDirs(dirs: string[], platform: NodeJS.Platform = process.platform, run: AttribRunner = runAttrib, exists: (p: string) => boolean = existsSync): Promise<string[]> {
  if (platform !== "win32") return [];
  const indexed: string[] = [];
  for (const dir of dirs.filter((d) => exists(d))) {
    const res = await run([dir, "/D"]);
    if (res.ok && parseNotIndexed(res.output, dir) === false) indexed.push(dir);
  }
  return indexed;
}

/** Set "not content indexed" on each dir that is currently indexed (creating nothing). Returns the dirs changed. */
export async function markDirsNotIndexed(
  dirs: string[],
  platform: NodeJS.Platform = process.platform,
  run: AttribRunner = runAttrib,
  exists: (p: string) => boolean = existsSync,
): Promise<string[]> {
  const changed: string[] = [];
  for (const dir of await findIndexedDirs(dirs, platform, run, exists)) {
    if ((await run(["+I", dir, "/D"])).ok) changed.push(dir);
  }
  return changed;
}

/** Best-effort start-up hook; never throws. */
export async function markWorkerDirsNotIndexed(workRoot: string | undefined, log: (line: string) => void = console.log): Promise<void> {
  try {
    const changed = await markDirsNotIndexed(workerDataDirs(workRoot));
    if (changed.length > 0) log(`[worker] marked not-content-indexed (Windows Search): ${changed.join(", ")}`);
  } catch {
    /* an indexing hint must never stop the worker */
  }
}

export async function checkContentIndexing(
  workRoot?: string,
  platform: NodeJS.Platform = process.platform,
  run: AttribRunner = runAttrib,
  dirs: string[] = workerDataDirs(workRoot),
  exists: (p: string) => boolean = existsSync,
): Promise<DoctorCheck | null> {
  if (platform !== "win32") return null;
  const name = "Windows Search indexing";
  const indexed = await findIndexedDirs(dirs, platform, run, exists);
  if (indexed.length === 0) return { name, status: "pass", detail: "worker data dirs are marked not-content-indexed" };
  return {
    name,
    status: "warn",
    detail:
      `Windows Search is indexing ${indexed.join(", ")} - SearchIndexer then dominates disk I/O and verify runs slow down many-fold`,
    remedy: `'worker start' marks them on its next start, or run: ${indexed.map((d) => `attrib +I "${d}" /D`).join("; ")} (reversible with -I; no admin). Defender exclusions are an operator choice, not set automatically.`,
  };
}

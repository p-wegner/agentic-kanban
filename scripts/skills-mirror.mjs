// Keeps the committed .codex/skills tree a mirror of .claude/skills (#1576).
//   node scripts/skills-mirror.mjs            copy .claude/skills -> .codex/skills (+ delete orphans), stage result
//   node scripts/skills-mirror.mjs --check    exit 1 if the git INDEX has a .claude/skills change without its mirror
// .claude/skills is canonical; codex-skills-parity.test.ts is the CI backstop for the same invariant.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gitExecSync } from "./git-exec.mjs";

const SRC = ".claude/skills/";
const DST = ".codex/skills/";
export const SYNC_COMMAND = "pnpm skills:mirror";

const eol = (s) => s.replace(/\r\n/g, "\n");

/** Pure: given index blobs for both trees (rel path -> blob hash) return the rel paths that are out of sync. */
export function findDrift(claude, codex, readBlob) {
  const drift = [];
  for (const rel of new Set([...claude.keys(), ...codex.keys()])) {
    const a = claude.get(rel);
    const b = codex.get(rel);
    if (a === b) continue;
    if (a && b && eol(readBlob(a)) === eol(readBlob(b))) continue;
    drift.push(rel);
  }
  return drift.sort();
}

function git(args, cwd) {
  return gitExecSync(args, { cwd });
}

function indexBlobs(prefix, cwd) {
  const map = new Map();
  for (const entry of git(["ls-files", "-s", "-z", "--", prefix], cwd).split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    map.set(entry.slice(tab + 1).slice(prefix.length), entry.slice(0, tab).split(/\s+/)[1]);
  }
  return map;
}

export function checkIndex(cwd = process.cwd()) {
  return findDrift(indexBlobs(SRC, cwd), indexBlobs(DST, cwd), (h) => git(["cat-file", "blob", h], cwd));
}

export function syncWorktree(cwd = process.cwd()) {
  const claude = indexBlobs(SRC, cwd);
  const codex = indexBlobs(DST, cwd);
  const touched = [];
  for (const rel of claude.keys()) {
    const from = join(cwd, SRC, rel);
    const to = join(cwd, DST, rel);
    if (!existsSync(from)) continue;
    const content = readFileSync(from);
    if (existsSync(to) && eol(readFileSync(to, "utf8")) === eol(content.toString("utf8"))) continue;
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, content);
    touched.push(DST + rel);
  }
  for (const rel of codex.keys()) {
    if (claude.has(rel)) continue;
    rmSync(join(cwd, DST, rel), { force: true });
    touched.push(DST + rel);
  }
  if (touched.length) git(["add", "-A", "--", ...touched], cwd);
  return touched;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    const drift = checkIndex();
    if (drift.length) {
      console.error(`[skills-mirror] .codex/skills is out of sync with .claude/skills for: ${drift.join(", ")}`);
      console.error(`[skills-mirror] fix: ${SYNC_COMMAND}  (then re-commit with the .codex/skills changes included)`);
      process.exit(1);
    }
  } else {
    const touched = syncWorktree();
    console.log(`[skills-mirror] ${touched.length ? `synced+staged ${touched.length} file(s)` : "already in sync"}`);
  }
}

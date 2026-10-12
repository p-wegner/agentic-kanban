// #1374 - the worker's own PATH policy. Db-free (standalone worker binary).
//
//  - Dirs the setup step installed CLIs into (`~/.local/bin`) are remembered next to the state file
//    and prepended to this process's PATH, so the daemon finds them whatever the login shell says.
//  - On WSL the Linux PATH carries the Windows PATH (`/mnt/c/...`). A Windows git/claude/codex found
//    through interop runs on the Windows side with Windows paths, so those entries are dropped.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

export function workerPathFileFor(stateFile: string): string {
  return join(dirname(stateFile), "worker-path.json");
}

/** WSL: `WSL_DISTRO_NAME` or `microsoft` in the kernel release. */
export function isWsl(
  env: NodeJS.ProcessEnv = process.env,
  readRelease: () => string = () => readFileSync("/proc/sys/kernel/osrelease", "utf8"),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readRelease());
  } catch {
    return false;
  }
}

/** `/mnt/c/...`: a Windows drive mounted into WSL. */
export function isWindowsMountPath(p: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(p.replace(/\\/g, "/"));
}

export function stripWindowsMounts(pathValue: string, sep = ":"): string {
  return pathValue.split(sep).filter((d) => d && !isWindowsMountPath(d)).join(sep);
}

export function readExtraPathDirs(stateFile: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(workerPathFileFor(stateFile), "utf8")) as { dirs?: unknown };
    return Array.isArray(raw.dirs) ? raw.dirs.filter((d): d is string => typeof d === "string" && d.length > 0) : [];
  } catch {
    return [];
  }
}

/** Remember `dir` for the daemon's spawn PATH. Returns false when it was already saved. */
export function saveExtraPathDir(stateFile: string, dir: string): boolean {
  const dirs = readExtraPathDirs(stateFile);
  if (dirs.includes(dir)) return false;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(workerPathFileFor(stateFile), JSON.stringify({ dirs: [...dirs, dir] }, null, 2), "utf8");
  return true;
}

/** Put `dir` first on `env.PATH` (no-op when already present). */
export function prependPath(env: NodeJS.ProcessEnv, dir: string, sep = delimiter): void {
  const parts = (env.PATH ?? "").split(sep).filter(Boolean);
  if (!parts.includes(dir)) env.PATH = [dir, ...parts].join(sep);
}

let originalPath: string | undefined;

/** The PATH as it was before WSL mounts were stripped (for the doctor's "only a Windows binary" message). */
export function unfilteredPath(env: NodeJS.ProcessEnv = process.env): string {
  return originalPath ?? env.PATH ?? "";
}

/**
 * Apply the worker's PATH policy to `env` (default: this process, so every child inherits it):
 * saved install dirs first, Windows interop entries removed on WSL.
 */
export function applyWorkerPath(
  stateFile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  wsl: boolean = isWsl(env),
  home: string = homedir(),
): void {
  if (originalPath === undefined) originalPath = env.PATH ?? "";
  if (wsl) env.PATH = stripWindowsMounts(originalPath ?? env.PATH ?? "");
  if (!stateFile) return;
  for (const dir of readExtraPathDirs(stateFile).reverse()) prependPath(env, dir);
  // #1410: a second pairing (new --state-file) has no saved dirs of its own; look where the first
  // setup put the CLIs and remember what exists for this worker too.
  for (const dir of discoverInstallDirs(stateFile, env, home)) {
    if (wsl && isWindowsMountPath(dir)) continue;
    prependPath(env, dir);
    try {
      saveExtraPathDir(stateFile, dir);
    } catch {
      /* read-only state dir: the PATH of this process is still fixed */
    }
  }
}

/** Dirs holding saved worker-path.json files of OTHER state files: siblings of this one and ~/.agentic-kanban. */
function otherSavedDirs(stateFile: string, home: string): string[] {
  const roots = new Set([dirname(stateFile), join(home, ".agentic-kanban")]);
  const found: string[] = [];
  const own = workerPathFileFor(stateFile);
  for (const root of roots) {
    const files = [join(root, "worker-path.json")];
    try {
      for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) files.push(join(root, e.name, "worker-path.json"));
    } catch {
      /* root missing */
    }
    for (const f of files) {
      if (f === own) continue;
      try {
        const raw = JSON.parse(readFileSync(f, "utf8")) as { dirs?: unknown };
        if (Array.isArray(raw.dirs)) for (const d of raw.dirs) if (typeof d === "string" && d) found.push(d);
      } catch {
        /* no file / unreadable */
      }
    }
  }
  return found;
}

/** Existing standard user install dirs plus install dirs saved by other state files, minus those already saved here. */
export function discoverInstallDirs(
  stateFile: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): string[] {
  const candidates = [join(home, ".local", "bin"), join(home, ".npm-global", "bin")];
  if (env.NPM_CONFIG_PREFIX) candidates.push(join(env.NPM_CONFIG_PREFIX, "bin"));
  candidates.push(...otherSavedDirs(stateFile, home));
  const saved = new Set(readExtraPathDirs(stateFile));
  return [...new Set(candidates)].filter((d) => !saved.has(d) && exists(d));
}

/** A `/mnt/<drive>/...` copy of `program` on the unfiltered PATH, or null. */
export function windowsOnlyCandidate(
  program: string,
  pathValue: string = unfilteredPath(),
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const dir of pathValue.split(":")) {
    if (!isWindowsMountPath(dir)) continue;
    for (const name of [program, `${program}.exe`, `${program}.cmd`]) {
      const candidate = `${dir.replace(/\/+$/, "")}/${name}`;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Doctor detail for a program that is missing from the (filtered) PATH on WSL but present as a
 * Windows binary under /mnt/<drive>; null when that does not apply.
 */
export function windowsOnlyMessage(program: string, wsl: boolean = isWsl()): string | null {
  if (!wsl) return null;
  const found = windowsOnlyCandidate(program);
  return found
    ? `the only '${program}' on this WSL machine is the Windows binary ${found}; it would run on the Windows side with Windows paths, so it is ignored - install a Linux ${program} inside this distro`
    : null;
}

/**
 * An npm global install on POSIX runs through a symlink (`<prefix>/bin/agentic-kanban-worker` ->
 * `<prefix>/lib/node_modules/<pkg>/bin/worker.js`), so argv[1] is the link; follow it to the
 * package's `bin/worker.js`. Null when it does not lead to one.
 */
export function workerEntryBehindSymlink(argv1: string): string | null {
  try {
    const real = realpathSync(argv1);
    if (basename(real) === "worker.js") return real;
    const sibling = join(dirname(real), "worker.js");
    return existsSync(sibling) ? sibling : null;
  } catch {
    return null;
  }
}

/** Test seam: forget the remembered original PATH. */
export function resetWorkerPathForTests(): void {
  originalPath = undefined;
}

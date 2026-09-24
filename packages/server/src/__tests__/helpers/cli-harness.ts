/**
 * Shared harness for the spawn-based CLI suites (`cli-*.test.ts`), split out of the one
 * 643 s `cli.test.ts` in #1236.
 *
 * Two costs dominated that file, and this helper removes both:
 *
 *  1. **Every case spawned `node --import tsx src/cli/index.ts`**, so each of ~65 spawns paid
 *     for transpiling the CLI's whole import graph (repositories, services, the shared
 *     package) — roughly 10 s per spawn on this box. `builtCliPath()` bundles the CLI ONCE per
 *     vitest worker process with esbuild (the same recipe as `scripts/build-server.mjs`, minus
 *     the dist wipe) and every case then runs plain JS.
 *  2. **Every case replayed all migrations into a fresh file.** `createCliTestDb()` copies the
 *     content-hash-keyed template DB from `helpers/test-db.ts` (#535) instead. Read-only cases
 *     share one such copy per file via `sharedReadOnlyDb()`; anything that mutates takes a
 *     fresh copy, which is a `copyFileSync` rather than 130 DDL statements.
 *
 * Where the bundle lives, and why the depth matters: `packages/server/node_modules/.ak-cli-test-<pid>/index.js`
 * is exactly TWO directories below `packages/server`, like the published `dist/cli/index.js`.
 * The CLI resolves `../../package.json` for `--version`, and `manual-migrate.ts` probes
 * `../../../shared/drizzle` for the dev migrations dir — both from the running module's own
 * directory, so a bundle one level deeper or shallower would resolve neither. Externals (hono,
 * commander, @libsql/client, …) resolve by walking up into `packages/server/node_modules`.
 * The shared package is bundled from `src/` via the `development` export condition, so these
 * suites never depend on a stale `packages/shared/dist`.
 */
import { buildSync } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@agentic-kanban/shared/schema";
import { buildProjectStatusRows } from "@agentic-kanban/shared/lib/project-statuses";
import { createTestDbFile } from "./test-db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SOURCE = resolve(__dirname, "../../cli/index.ts");
export const PKG_DIR = resolve(__dirname, "../../..");
export const REPO_ROOT = resolve(PKG_DIR, "../..");

const BUNDLE_DIR_PREFIX = ".ak-cli-test-";

let builtCli: string | null = null;

/** Best-effort: remove bundle dirs left by vitest workers that were killed before their exit hook. */
function sweepStaleBundleDirs(nodeModules: string): void {
  let entries: string[];
  try {
    entries = readdirSync(nodeModules);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(BUNDLE_DIR_PREFIX)) continue;
    const pid = Number(name.slice(BUNDLE_DIR_PREFIX.length));
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0); // alive — another worker's live bundle
      continue;
    } catch {
      /* not alive (or not ours to signal) — treat as stale */
    }
    try {
      rmSync(join(nodeModules, name), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Path of the CLI bundle for this process, built on first call. One esbuild run per vitest
 * worker (~1-2 s) instead of one tsx transpile per spawned case.
 */
export function builtCliPath(): string {
  if (builtCli && existsSync(builtCli)) return builtCli;
  const nodeModules = resolve(PKG_DIR, "node_modules");
  sweepStaleBundleDirs(nodeModules);
  const outDir = join(nodeModules, `${BUNDLE_DIR_PREFIX}${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, "index.js");
  buildSync({
    entryPoints: [CLI_SOURCE],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    // Bundle @agentic-kanban/shared from its SOURCE, not from a possibly stale dist/.
    conditions: ["development"],
    // Same external set as scripts/build-server.mjs: runtime deps stay outside the bundle
    // (the Agent SDK and ts-morph MUST — they resolve native binaries / `__filename` at init).
    external: [
      "hono",
      "@hono/node-server",
      "@hono/node-ws",
      "@hono/node-server/serve-static",
      "drizzle-orm",
      "drizzle-orm/libsql/migrator",
      "drizzle-orm/libsql",
      "@libsql/client",
      "commander",
      "@modelcontextprotocol/sdk",
      "@anthropic-ai/claude-agent-sdk",
      "zod",
      "ts-morph",
    ],
    banner: {
      js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
    },
    logLevel: "silent",
  });
  builtCli = outfile;
  process.on("exit", () => {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  return outfile;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Run the bundled CLI against `dbPath`. */
export function runCli(args: string[], dbPath: string): CliResult {
  const result = spawnSync(process.execPath, [builtCliPath(), ...args], {
    env: { ...process.env, DB_URL: `file:${dbPath}` },
    cwd: PKG_DIR,
    encoding: "utf-8",
    windowsHide: true,
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    status: result.status ?? 1,
  };
}

/**
 * Run the CLI THROUGH the root `pnpm cli` wrapper — the door an operator uses, with its
 * `--disable-warning` flags and shared-freshness check. Slow (tsx, not the bundle); only for
 * cases that assert something about the wrapper itself.
 */
export function runPnpmCli(args: string[], dbPath: string): CliResult & { error?: string } {
  const pnpm = "pnpm";
  if (!existsSync(resolve(REPO_ROOT, "packages/shared/dist/index.js"))) {
    const build = spawnSync(pnpm, ["--filter", "shared", "build"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    if (build.status !== 0) {
      return {
        stdout: build.stdout || "",
        stderr: build.stderr || "",
        status: build.status ?? 1,
      };
    }
  }
  const result = spawnSync(pnpm, ["cli", "--", ...args], {
    env: { ...process.env, DB_URL: `file:${dbPath}` },
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message,
    status: result.status ?? 1,
  };
}

export interface CliTestDb {
  dbPath: string;
  cleanup: () => void;
}

/**
 * A fresh, fully-migrated file DB for one case — a copy of the template, with the
 * `__drizzle_migrations` bookkeeping already stamped by TAG so the CLI's own `runMigrations()`
 * is a no-op (#954: the migrator skips on tag, not on a content hash).
 */
export function createCliTestDb(): CliTestDb {
  const { dbPath, dispose } = createTestDbFile();
  return { dbPath, cleanup: dispose };
}

/**
 * One DB per FILE for cases that only read (help, version, an empty listing, an error path
 * that never reaches an insert). Call from `beforeAll`; the harness disposes it on exit if the
 * caller forgets, like every other template copy.
 */
export function sharedReadOnlyDb(): CliTestDb {
  return createCliTestDb();
}

export async function seedProject(dbPath: string, overrides: { name?: string; repoPath?: string } = {}) {
  const client = createClient({ url: `file:${dbPath}` });
  const database = drizzle(client, { schema });
  const now = new Date().toISOString();
  const id = randomUUID();
  const name = overrides.name || "Test Project";
  const repoPath = overrides.repoPath || "/tmp/test-repo";

  await database.insert(schema.projects).values({
    id, name, repoPath, repoName: "test-repo", defaultBranch: "main", createdAt: now, updatedAt: now,
  });

  // The production topology, from the one place that defines it (#563). This used to be
  // a fourth hand-maintained copy here, and it had already lost the "Backlog" column.
  for (const row of buildProjectStatusRows(id, now)) {
    await database.insert(schema.projectStatuses).values(row);
  }

  await database.insert(schema.preferences).values({ key: "activeProjectId", value: id, updatedAt: now })
    .onConflictDoUpdate({ target: schema.preferences.key, set: { value: id, updatedAt: now } });

  client.close();
  return { id, name };
}

export async function seedIssue(
  dbPath: string,
  projectId: string,
  overrides: { title?: string; statusName?: string; priority?: string } = {},
) {
  const client = createClient({ url: `file:${dbPath}` });
  const database = drizzle(client, { schema });
  const now = new Date().toISOString();
  const id = randomUUID();

  const statusRows = await database.select().from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.projectId, projectId));
  const targetStatus = overrides.statusName
    ? statusRows.find(s => s.name === overrides.statusName)
    : statusRows.find(s => s.name === "Todo");

  if (!targetStatus) throw new Error(`Status not found for project ${projectId}`);

  const maxResult = await database.select({ maxNum: sql<number | null>`max(${schema.issues.issueNumber})` })
    .from(schema.issues).where(eq(schema.issues.projectId, projectId));
  const issueNumber = (maxResult[0]?.maxNum ?? 0) + 1;

  await database.insert(schema.issues).values({
    id, issueNumber, title: overrides.title || "Test Issue", description: null,
    priority: (overrides.priority as any) || "medium", sortOrder: 0,
    statusId: targetStatus.id, projectId, createdAt: now, updatedAt: now,
  });

  client.close();
  return { id, issueNumber };
}

/** Insert one workspace row directly (no worktree on disk). */
export async function seedWorkspace(
  dbPath: string,
  issueId: string,
  opts: { id?: string; branch?: string; workingDir?: string; status?: string; isDirect?: boolean } = {},
) {
  const client = createClient({ url: `file:${dbPath}` });
  const database = drizzle(client, { schema });
  const now = new Date().toISOString();
  const id = opts.id ?? randomUUID();
  await database.insert(schema.workspaces).values({
    id, issueId, branch: opts.branch ?? "feature/test", workingDir: opts.workingDir ?? "/tmp/worktree",
    baseBranch: "main", isDirect: opts.isDirect ?? false, status: opts.status ?? "closed",
    createdAt: now, updatedAt: now,
  });
  client.close();
  return { id };
}

let fixtureRepo: string | null = null;

/**
 * A real `git init` MAIN checkout in temp, once per process, for `register` cases.
 *
 * `cli.test.ts` registered the server package dir itself, which `register` refuses whenever
 * the suite runs from a linked worktree ("is a linked git worktree, not a main checkout") —
 * i.e. in every builder worktree on this board. `api-test-helpers.ensureFixtureRepo` does the
 * same thing but drags the whole app import graph into the worker (measured: import 1.6 s →
 * 27 s), which is why it is not reused here.
 */
export function fixtureMainRepo(): string {
  if (fixtureRepo && existsSync(join(fixtureRepo, ".git", "HEAD"))) return fixtureRepo;
  const parent = mkdtempSync(join(tmpdir(), "ak-cli-fixture-repo-"));
  const repoPath = join(parent, "test-repo");
  mkdirSync(repoPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "pipe", windowsHide: true });
  git("init", "-b", "main");
  writeFileSync(join(repoPath, "README.md"), "cli test fixture\n", "utf8");
  git("add", "README.md");
  git("commit", "-m", "initial commit");
  fixtureRepo = repoPath;
  process.on("exit", () => {
    try {
      rmSync(parent, { recursive: true, force: true, maxRetries: 1 });
    } catch {
      /* the globalSetup `ak-` sweep is the backstop */
    }
  });
  return repoPath;
}

/** Open a drizzle handle on a test DB for a direct read/insert; the caller closes it. */
export function openDb(dbPath: string) {
  const client = createClient({ url: `file:${dbPath}` });
  const database = drizzle(client, { schema });
  return { client, db: database, close: () => client.close() };
}

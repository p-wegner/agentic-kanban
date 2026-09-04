#!/usr/bin/env node
/**
 * Boot-from-dist smoke check (#1012).
 *
 * Proves the claim the npm publish pipeline makes and nothing verifies: the board BOOTS
 * from its BUILT artifact — `packages/server/dist/cli/index.js` (what `pnpm start` runs and
 * what `npx agentic-kanban` ships) — with the two directories a dev run resolves by a
 * completely different path:
 *
 *   - the drizzle MIGRATIONS, which in a dev run live at `packages/shared/drizzle` and in a
 *     built run at `packages/server/dist/migrations` (copied by `scripts/copy-assets.mjs`,
 *     probed by `getMigrationsFolder()`'s candidate ladder), and
 *   - the BUNDLED SKILLS directory `packages/server/skills`, which `findBundledSkillsDir()`
 *     locates by walking UP from the running module — from `dist/` in a built run, from
 *     `packages/shared/src/lib` under tsx.
 *
 * Both resolutions are invisible in a dev run: they work for the wrong reason there.
 *
 * ## Why a throwaway git worktree
 *
 * `scripts/build-server.mjs` wipes `packages/server/dist` unconditionally. Building in the
 * live checkout would delete the dist of whatever else is running (a served UI, another
 * agent's gate). So this checks out HEAD into a throwaway `git worktree` under the OS temp
 * dir and builds THERE, and removes it again afterwards.
 *
 * ## node_modules: junctioned, not installed
 *
 * A `pnpm install` in the throwaway would cost minutes. The throwaway's `node_modules`
 * directories are therefore symlinks (Windows junctions) to the live checkout's, which are
 * only ever READ here — the build writes to `dist/`, never into `node_modules/`.
 *
 * One consequence is deliberate and worth knowing: `@agentic-kanban/shared` resolves through
 * those junctions to the LIVE checkout's `packages/shared/dist`, so the bundle's shared half
 * comes from there rather than from the throwaway. That is fine for what this checks — the
 * two directory RESOLUTIONS above are the throwaway's own (`dist/migrations` is copied from
 * the throwaway's `packages/shared/drizzle`, `skills/` is the throwaway's) — but it means
 * this is a boot smoke test, not a hermetic cold-clone build check. The cold-clone check is
 * `scripts/coldclone-build-check.sh`, which does a real clone and a real `pnpm install`.
 *
 * ## Usage
 *
 *   node scripts/boot-dist-smoke.mjs            # build + boot + probe, then clean up
 *   node scripts/boot-dist-smoke.mjs --json     # same, with a machine-readable result line
 *   node scripts/boot-dist-smoke.mjs --full     # run the whole `pnpm build` (adds the client)
 *   node scripts/boot-dist-smoke.mjs --break-skills   # fault injection: rename the bundled
 *                                                     # skills dir away and expect the failure
 *   node scripts/boot-dist-smoke.mjs --keep     # leave the throwaway worktree for inspection
 *
 * Exit code 0 = every check passed (with `--break-skills`: the skills check failed as it
 * must, and said which directory was missing).
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawnSyncPnpm } from "./pnpm-exec.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories whose `node_modules` the throwaway borrows from the live checkout. */
const NODE_MODULES_HOSTS = ["", "packages/server", "packages/shared", "packages/client", "packages/mcp-server"];

/** How long the built server gets to answer /health before this gives up. */
const BOOT_TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const opts = {
  json: args.includes("--json"),
  full: args.includes("--full"),
  breakSkills: args.includes("--break-skills"),
  keep: args.includes("--keep"),
};

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!opts.json) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function run(cmd, cmdArgs, cwd) {
  const res = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", windowsHide: true });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${cmdArgs.join(" ")} failed (exit ${res.status}) in ${cwd}\n${res.stdout ?? ""}\n${res.stderr ?? ""}`,
    );
  }
  return res.stdout ?? "";
}

/** A free TCP port. Never guessed: a guessed port in 30000-60000 hits Windows' reserved ranges. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/**
 * Remove a symlink/junction WITHOUT recursing into it. The throwaway's `node_modules` links
 * point into the live checkout, so a naive recursive delete of the temp tree is the one way
 * this script could do real damage.
 */
function removeLink(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p);
  }
}

async function main() {
  // The bundle's shared half comes from the live checkout's dist (see the header), so say so
  // now rather than failing later inside an esbuild resolution error.
  const sharedDist = join(REPO_ROOT, "packages/shared/dist/index.js");
  if (!existsSync(sharedDist)) {
    throw new Error(`${sharedDist} is missing — run: pnpm --filter @agentic-kanban/shared build`);
  }
  if (!existsSync(join(REPO_ROOT, "node_modules"))) {
    throw new Error(`${join(REPO_ROOT, "node_modules")} is missing — run: pnpm install`);
  }

  const work = mkdtempSync(join(tmpdir(), "ak-boot-dist-"));
  const checkout = join(work, "checkout");
  const dbPath = join(work, "smoke.db");
  const links = [];
  let child = null;
  let worktreeAdded = false;

  try {
    run("git", ["worktree", "add", "--detach", checkout, "HEAD"], REPO_ROOT);
    worktreeAdded = true;

    for (const host of NODE_MODULES_HOSTS) {
      const from = join(REPO_ROOT, host, "node_modules");
      if (!existsSync(from)) continue;
      const to = join(checkout, host, "node_modules");
      symlinkSync(from, to, "junction");
      links.push(to);
    }
    record("node_modules junctioned into the throwaway worktree", true, `${links.length} link(s)`);

    if (opts.full) {
      const res = spawnSyncPnpm(["build"], { cwd: checkout, encoding: "utf8" });
      if (res.status !== 0) throw new Error(`pnpm build failed (exit ${res.status})\n${res.stdout ?? ""}\n${res.stderr ?? ""}`);
    } else {
      run(process.execPath, [join(checkout, "scripts/build-server.mjs")], checkout);
      run(process.execPath, [join(checkout, "scripts/copy-assets.mjs")], checkout);
    }

    const serverEntry = join(checkout, "packages/server/dist/server.js");
    const cliEntry = join(checkout, "packages/server/dist/cli/index.js");
    record("built artifacts exist", existsSync(serverEntry) && existsSync(cliEntry), cliEntry);

    const journal = join(checkout, "packages/server/dist/migrations/meta/_journal.json");
    record("migrations copied into dist", existsSync(journal), journal);

    const skillsDir = join(checkout, "packages/server/skills");
    if (opts.breakSkills) renameSync(skillsDir, `${skillsDir}.renamed-by-smoke-test`);

    // --- the bundled skills directory, as seen BY THE BUILT CLI ------------------------
    // `skill verify` prints `Bundle: <dir>`, which is `findBundledSkillsDir()`'s answer from
    // inside dist/cli/index.js — the exact resolution an `npx agentic-kanban` install makes.
    const verify = spawnSync(process.execPath, [cliEntry, "skill", "verify", work], {
      cwd: checkout,
      encoding: "utf8",
      windowsHide: true,
      env: bootEnv(dbPath, 0),
    });
    const bundleLine = /^Bundle: (.+)$/m.exec(verify.stdout ?? "");
    const bundleDir = bundleLine ? bundleLine[1].trim() : null;
    record(
      "built CLI resolves the bundled skills directory",
      bundleDir === skillsDir,
      bundleDir
        ? `resolved ${bundleDir}`
        : `bundled skills directory not found — expected ${skillsDir} (the built CLI at ${cliEntry} ` +
          `resolved no bundle; stdout/stderr: ${(verify.stdout ?? "").trim()} ${(verify.stderr ?? "").trim()})`,
    );

    // --- boot the built server --------------------------------------------------------
    const port = await freePort();
    const log = [];
    child = spawn(process.execPath, [cliEntry, "dev", "--port", String(port), "--no-open"], {
      cwd: checkout,
      env: bootEnv(dbPath, port),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => log.push(String(d)));
    child.stderr.on("data", (d) => log.push(String(d)));
    let exited = null;
    child.on("exit", (code) => { exited = code; });

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let health = null;
    while (Date.now() < deadline && exited === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        health = { status: res.status, body: await res.json() };
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const tail = log.join("").split(/\r?\n/).slice(-25).join("\n");
    record(
      "built server answers /health with ok",
      health?.status === 200 && health.body?.status === "ok",
      health ? JSON.stringify(health.body) : `no response within ${BOOT_TIMEOUT_MS}ms (exit ${exited})\n${tail}`,
    );
    const journalCheck = health?.body?.checks?.find((c) => c.name === "migrations-journal");
    record(
      "/health resolves the migrations journal from the BUILT location",
      Boolean(journalCheck?.ok) && String(journalCheck?.detail ?? "").includes("dist"),
      journalCheck ? journalCheck.detail : "no migrations-journal check — the server did not run in bundled mode",
    );

    let projects = null;
    if (health) {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
      const body = await res.json().catch(() => null);
      projects = { status: res.status, isArray: Array.isArray(body) || Array.isArray(body?.projects) };
    }
    record(
      "GET /api/projects answers from the migrated temp DB",
      projects?.status === 200 && projects.isArray,
      projects ? `status ${projects.status}` : "not attempted (server never came up)",
    );

    // --- migrations really ran, in the temp DB, from the built journal -----------------
    const expected = existsSync(journal)
      ? JSON.parse(readFileSync(journal, "utf8")).entries.length
      : 0;
    let applied = 0;
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        applied = Number(db.prepare("select count(*) as n from __drizzle_migrations").get().n);
      } finally {
        db.close();
      }
    }
    record(
      "every journal migration is applied in the temp DB",
      expected > 0 && applied === expected,
      `${applied}/${expected} applied in ${dbPath}`,
    );
  } finally {
    if (child && child.exitCode === null) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    }
    if (!opts.keep) {
      // Links FIRST: they point into the live checkout, and nothing below may follow them.
      for (const link of links) removeLink(link);
      if (worktreeAdded) {
        spawnSync("git", ["worktree", "remove", "--force", checkout], { cwd: REPO_ROOT, windowsHide: true });
        spawnSync("git", ["worktree", "prune"], { cwd: REPO_ROOT, windowsHide: true });
      }
      try {
        rmSync(work, { recursive: true, force: true, maxRetries: 5 });
      } catch { /* a locked temp file is not a failure of what this checks */ }
    } else if (!opts.json) {
      console.log(`\nkept: ${work} (remove with: git worktree remove --force ${checkout})`);
    }
  }
}

/** Env for a booted/invoked built artifact: the temp DB, never the real one. */
function bootEnv(dbPath, port) {
  const env = { ...process.env, KANBAN_DB_URL: `file:${dbPath}`, KANBAN_HOST: "127.0.0.1", PORT: String(port) };
  // A vitest parent would otherwise push the child onto the per-process throwaway DB path,
  // and AGENTIC_KANBAN_DIR/DB_URL would fight KANBAN_DB_URL for precedence.
  delete env.VITEST;
  delete env.NODE_ENV;
  delete env.AGENTIC_KANBAN_DIR;
  delete env.DB_URL;
  // The board writes its own worktree-scoping var into agent envs; it must not leak into a
  // server that is supposed to look like a fresh install.
  delete env.KANBAN_WORKTREE_DIR;
  return env;
}

let failed = false;
try {
  await main();
} catch (err) {
  record("smoke run completed", false, err instanceof Error ? err.message : String(err));
  failed = true;
}

// With --break-skills the skills check MUST fail (and must name the directory); everything
// else must still pass. That inversion is the acceptance criterion, so it is expressed here
// rather than left to the caller.
const skillsCheck = checks.find((c) => c.name === "built CLI resolves the bundled skills directory");
const others = checks.filter((c) => c !== skillsCheck);
const ok = opts.breakSkills
  ? !failed && skillsCheck?.ok === false && String(skillsCheck.detail).includes("skills") && others.every((c) => c.ok)
  : !failed && checks.every((c) => c.ok);

if (opts.json) {
  console.log(JSON.stringify({ ok, mode: opts.breakSkills ? "break-skills" : "normal", checks }));
} else {
  console.log(`\n${ok ? "OK" : "FAILED"} — boot-from-dist smoke (${checks.filter((c) => c.ok).length}/${checks.length} checks passed)`);
}
process.exit(ok ? 0 : 1);

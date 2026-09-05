#!/usr/bin/env node
/**
 * `pnpm promote` — the drawbridge between the dev board and the stable board (#1014).
 *
 * `docs/two-boards.md` splits the board in two: this checkout develops itself and is allowed
 * to be red, a SECOND checkout runs the built artifact against the operated database and never
 * is. Master reaches that second checkout by a TIMED promotion, not per merge — which is the
 * one moment the full suite decides anything
 * (`docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §3.A, Yegge's drawbridge).
 *
 * One run does, in order:
 *
 *   1. reads the last full-sweep verdict for master out of the board's `base_branch_health`
 *      table — via `GET /api/projects/:id/base-branch-health` when a board answers, else a
 *      READ-ONLY sqlite query. It never re-runs the suite and never writes to that database.
 *   2. tags `stable-YYYYMMDD` (`-2`, `-3`, … if the day already has one) on the green sha,
 *   3. in the stable checkout: fetch, fast-forward to the tag, install only if the lockfile
 *      moved, build, migrate, restart,
 *   4. smokes `/health`, `GET /api/projects` (non-empty) and one board-status call; on failure
 *      fast-forwards back to the previous `stable-*` tag, rebuilds, restarts and says so.
 *
 * Every step is appended to `<stable checkout>/.kanban/promote.log`, which is what the
 * Sentinel reads.
 *
 * Usage:
 *   node scripts/promote.mjs --dry-run     # print the resolved sha/tag/paths and every step; touch nothing
 *   node scripts/promote.mjs               # promote
 *   node scripts/promote.mjs --force-sweep # promote WITHOUT a green sweep (loud warning)
 *
 * Rehearsal: KANBAN_PROMOTE_FORCE_SMOKE_FAILURE=1 fails the promotion's smoke on purpose (one
 * shot — the rollback's smoke stays real), which is how the rollback half of #1014's acceptance
 * is exercised without breaking anything real.
 *
 * Env: KANBAN_STABLE_CHECKOUT, KANBAN_STABLE_PORT, KANBAN_PROMOTE_BOARD_URL, KANBAN_PROMOTE_DB,
 * KANBAN_PROMOTE_PROJECT, KANBAN_PROMOTE_BRANCH, KANBAN_PROMOTE_MAX_SWEEP_AGE_H — all
 * documented in `docs/env-vars.md`.
 */
import { spawn, spawnSync, execSync, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecSyncResult } from "./git-exec.mjs";
import { spawnSyncPnpm } from "./pnpm-exec.mjs";
import { parseNetstatListeners, planPortOwnerKill } from "./dev-port-guard.mjs";
import {
  PROMOTE_LOG_RELPATH,
  buildPromotionPlan,
  checkPromoteDirection,
  formatPlan,
  nextStableTag,
  parseSweepVerdict,
  previousStableTag,
  resolveBoardUrl,
  resolveMaxSweepAgeMs,
  resolveOperatedDbPath,
  resolveProjectName,
  resolveStableCheckout,
  shouldForceSmokeFailure,
  shouldReinstall,
  stableTagDate,
} from "./promote-plan.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const opts = {
  dryRun: args.includes("--dry-run"),
  forceSweep: args.includes("--force-sweep"),
};

/**
 * The MAIN checkout of this repository, which is what the default stable-checkout path is a
 * sibling OF. Run from a worktree, `REPO_ROOT` is that worktree (typically nested under
 * `.claude/worktrees/`), and the sibling default would land somewhere meaningless — so ask git
 * for the common git dir and take its parent. Falls back to `REPO_ROOT` when that fails.
 */
function mainCheckoutRoot() {
  const res = gitExecSyncResult(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO_ROOT });
  const out = res.stdout.trim();
  if (res.code !== 0 || !out) return REPO_ROOT;
  return /[\\/]\.git$/.test(out) ? dirname(out) : REPO_ROOT;
}

const env = process.env;
const MAIN_CHECKOUT = mainCheckoutRoot();
const stableCheckout = resolveStableCheckout({ env, repoRoot: MAIN_CHECKOUT });
const boardUrl = resolveBoardUrl(env);
const dbPath = resolveOperatedDbPath({ env });
const projectName = resolveProjectName(env);
const baseBranch = env.KANBAN_PROMOTE_BRANCH || "master";
const stablePort = Number(env.KANBAN_STABLE_PORT || 3001);
const dbUrl = env.KANBAN_DB_URL || `file:${dbPath.replace(/\\/g, "/")}`;
const logPath = join(stableCheckout, PROMOTE_LOG_RELPATH);

/** Append to the promote log — and to stdout. A dry run never writes the file. */
function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(line);
  if (opts.dryRun) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${stamped}\n`, "utf8");
  } catch (e) {
    console.warn(`[promote] could not append to ${logPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function fail(message) {
  log(`\n[promote] REFUSED — ${message}`);
  process.exit(1);
}

/** Thin alias over the scripts-tier adapter (`scripts/git-exec.mjs`) — never throws, trimmed streams. */
function git(gitArgs, cwd = REPO_ROOT) {
  const res = gitExecSyncResult(gitArgs, { cwd });
  return { code: res.code, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

function gitOrThrow(gitArgs, cwd = REPO_ROOT) {
  const r = git(gitArgs, cwd);
  if (r.code !== 0) throw new Error(`git ${gitArgs.join(" ")} failed in ${cwd} (exit ${r.code}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

// --- step 1: the sweep verdict ------------------------------------------------------------

async function readSweepRowViaHttp() {
  const projectsRes = await fetch(`${boardUrl}/api/projects`, { signal: AbortSignal.timeout(5000) });
  if (!projectsRes.ok) throw new Error(`GET /api/projects -> ${projectsRes.status}`);
  const body = await projectsRes.json();
  const projects = Array.isArray(body) ? body : (body?.projects ?? []);
  const project = projects.find((p) => p?.name === projectName || p?.slug === projectName);
  if (!project) throw new Error(`no project named '${projectName}' on ${boardUrl}`);
  const healthRes = await fetch(`${boardUrl}/api/projects/${project.id}/base-branch-health?limit=20`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!healthRes.ok) throw new Error(`GET /api/projects/${project.id}/base-branch-health -> ${healthRes.status}`);
  const health = await healthRes.json();
  return { row: health?.latest ?? null, projectId: project.id, source: `board HTTP ${boardUrl}` };
}

/**
 * READ-ONLY fallback. `node:sqlite`'s `DatabaseSync` is opened with `readOnly: true` and only
 * SELECTs are issued — the operated database is the stable board's live data and this script
 * is never allowed to write to it.
 */
async function readSweepRowViaSqlite() {
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const project = db
      .prepare("select id, name from projects where name = ? limit 1")
      .get(projectName);
    if (!project) throw new Error(`no project named '${projectName}' in ${dbPath}`);
    const row = db
      .prepare(
        "select sha, branch, outcome, message, created_at from base_branch_health where project_id = ? order by created_at desc limit 1",
      )
      .get(project.id);
    return { row: row ?? null, projectId: project.id, source: `read-only sqlite ${dbPath}` };
  } finally {
    db.close();
  }
}

async function readSweepRow() {
  try {
    return await readSweepRowViaHttp();
  } catch (httpErr) {
    const httpReason = httpErr instanceof Error ? httpErr.message : String(httpErr);
    try {
      const viaDb = await readSweepRowViaSqlite();
      return { ...viaDb, source: `${viaDb.source} (board HTTP unavailable: ${httpReason})` };
    } catch (dbErr) {
      const dbReason = dbErr instanceof Error ? dbErr.message : String(dbErr);
      return { row: null, projectId: null, source: `UNREADABLE (http: ${httpReason}; db: ${dbReason})`, unreadable: true };
    }
  }
}

// --- the stable board's process ------------------------------------------------------------

function listenerPidsOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      return parseNetstatListeners(out, port);
    }
    const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return [...new Set(out.split("\n").map((p) => p.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function processCommandLine(pid) {
  try {
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`;
      return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }).trim();
    }
    return execSync(`ps -p ${pid} -o command=`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Stop the stable board — BY SIGNATURE ONLY.
 *
 * `planPortOwnerKill` (shared with `scripts/dev.mjs`) refuses any pid whose command line does
 * not contain the stable checkout's path, so this can never take down another agent's worktree
 * server, another board, or an unrelated node process. There is no kill-all-node path here and
 * there must never be one.
 */
function stopStableBoard() {
  const pids = listenerPidsOnPort(stablePort);
  if (pids.length === 0) {
    log(`[promote] nothing listening on ${stablePort} — nothing to stop`);
    return;
  }
  for (const pid of pids) {
    const decision = planPortOwnerKill({
      pid,
      port: stablePort,
      checkoutRoot: stableCheckout,
      getCommandLine: processCommandLine,
      audit: (e) => log(`[promote] ${JSON.stringify(e)}`),
    });
    if (!decision.allowed) {
      throw new Error(
        `refusing to stop pid ${pid} on port ${stablePort}: its command line does not belong to ${stableCheckout} ` +
          `(${decision.reason}). Something other than the stable board holds that port — resolve it by hand.`,
      );
    }
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "pipe" });
    } else {
      spawnSync("kill", ["-9", String(pid)], { stdio: "pipe" });
    }
    log(`[promote] stopped stable board pid ${pid} on port ${stablePort}`);
  }
}

/**
 * Start the stable board headless and detached: the BUILT artifact
 * (`packages/server/dist/cli/index.js dev`), exactly what `pnpm --filter agentic-kanban start`
 * runs, spawned directly so the process command line carries the stable checkout's path — which
 * is what makes {@link stopStableBoard}'s signature check able to recognise it later. Output
 * goes to the promote log; `windowsHide` and `detached`+`unref` keep it from flashing a window
 * or dying with this script.
 */
function startStableBoard() {
  const cli = join(stableCheckout, "packages", "server", "dist", "cli", "index.js");
  if (!existsSync(cli)) throw new Error(`built CLI missing: ${cli} (did the build step run?)`);
  mkdirSync(dirname(logPath), { recursive: true });
  const out = openSync(logPath, "a");
  const child = spawn(process.execPath, [cli, "dev", "--port", String(stablePort), "--no-open"], {
    cwd: stableCheckout,
    env: { ...process.env, KANBAN_DB_URL: dbUrl, KANBAN_HOST: "127.0.0.1", PORT: String(stablePort) },
    windowsHide: true,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  log(`[promote] started stable board pid ${child.pid} on ${stablePort} (cwd ${stableCheckout})`);
  return child.pid;
}

async function waitForHealth(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${boardUrl}/health`, { signal: AbortSignal.timeout(4000) });
      const body = await res.json().catch(() => null);
      if (res.status === 200) return { ok: true, body };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, body: null };
}

/**
 * Armed by `KANBAN_PROMOTE_FORCE_SMOKE_FAILURE` and consumed by the first smoke that reads it,
 * so a rehearsal fails the PROMOTION's smoke and then lets the ROLLBACK's smoke be real.
 */
let forcedSmokeFailureArmed = shouldForceSmokeFailure(env);

/** `/health`, a non-empty `GET /api/projects`, and one board-status call. */
async function smoke() {
  const health = await waitForHealth();
  if (!health.ok) return { ok: false, failed: "/health", detail: "no 200 within the boot timeout" };

  // After /health, so a rehearsal still proves the restart worked before it forces the failure.
  if (forcedSmokeFailureArmed) {
    forcedSmokeFailureArmed = false;
    log("[promote] KANBAN_PROMOTE_FORCE_SMOKE_FAILURE is set — failing this smoke ON PURPOSE (one-shot; the rollback's smoke is real)");
    return { ok: false, failed: "FORCED (KANBAN_PROMOTE_FORCE_SMOKE_FAILURE)", detail: "rehearsal of the rollback path — the board itself answered /health" };
  }

  const projectsRes = await fetch(`${boardUrl}/api/projects`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const projectsBody = projectsRes ? await projectsRes.json().catch(() => null) : null;
  const projects = Array.isArray(projectsBody) ? projectsBody : (projectsBody?.projects ?? []);
  if (!projectsRes || projectsRes.status !== 200 || projects.length === 0) {
    return { ok: false, failed: "GET /api/projects", detail: `status ${projectsRes?.status ?? "none"}, ${projects.length} project(s) — an EMPTY list means the DB pin is wrong` };
  }

  const project = projects.find((p) => p?.name === projectName) ?? projects[0];
  const issuesRes = await fetch(`${boardUrl}/api/issues?projectId=${project.id}&slim=1&limit=5`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const issuesBody = issuesRes ? await issuesRes.json().catch(() => null) : null;
  if (!issuesRes || issuesRes.status !== 200 || !(Array.isArray(issuesBody) || Array.isArray(issuesBody?.issues))) {
    return { ok: false, failed: "GET /api/issues (board status)", detail: `status ${issuesRes?.status ?? "none"} for project ${project.id}` };
  }
  return { ok: true, detail: `${projects.length} project(s); board status answered for '${project.name}'` };
}

// --- build / install / migrate --------------------------------------------------------------

function pnpmInStable(pnpmArgs, label) {
  log(`[promote] pnpm ${pnpmArgs.join(" ")} (in ${stableCheckout})`);
  const res = spawnSyncPnpm(pnpmArgs, {
    cwd: stableCheckout,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, KANBAN_DB_URL: dbUrl },
  });
  if (res.status !== 0) {
    throw new Error(`${label} failed (exit ${res.status})\n${(res.stdout ?? "").slice(-4000)}\n${(res.stderr ?? "").slice(-4000)}`);
  }
}

function lockHash(cwd) {
  const r = git(["rev-parse", "HEAD:pnpm-lock.yaml"], cwd);
  return r.code === 0 ? r.stdout : "";
}

/**
 * fast-forward → (install) → build → migrate. Shared by the promotion and the rollback.
 *
 * `hard` is the rollback's door: a fast-forward cannot go BACKWARDS to the previous tag, so
 * the rollback resets instead. It is only ever reached after the clean-tree check above, and
 * only onto a tag this script itself created.
 */
function deployRef(ref, { hard = false } = {}) {
  const lockBefore = lockHash(stableCheckout);
  gitOrThrow(hard ? ["reset", "--hard", ref] : ["merge", "--ff-only", ref], stableCheckout);
  log(`[promote] ${stableCheckout} ${hard ? "reset" : "fast-forwarded"} to ${ref} (${gitOrThrow(["rev-parse", "HEAD"], stableCheckout)})`);
  const lockAfter = lockHash(stableCheckout);
  if (shouldReinstall(lockBefore, lockAfter)) {
    pnpmInStable(["install", "-r", "--prefer-offline"], "pnpm install");
  } else {
    log("[promote] pnpm-lock.yaml unchanged — skipping install");
  }
  pnpmInStable(["build"], "pnpm build");
  pnpmInStable(["--filter", "agentic-kanban", "db:migrate"], "pnpm db:migrate");
}

/**
 * Rename the tag of a promotion that failed and was rolled back, out of the `stable-*` namespace.
 *
 * `previousStableTag` picks the NEWEST `stable-*` as the next run's rollback target — so leaving a
 * failed tag there means a future failed promotion rolls back ONTO a version that already failed
 * its own smoke, silently. The tag is kept (as `failed-promotion-<tag>`) rather than deleted: what
 * was attempted and rejected is exactly the thing a post-mortem wants.
 */
function retireFailedTag(tag) {
  const retired = `failed-promotion-${tag}`;
  const created = git(["tag", retired, tag]);
  if (created.code !== 0) {
    log(`[promote] !!! could not record the failed tag as ${retired} (${created.stderr}) — LEAVING ${tag} in place; the next rollback would target it.`);
    return;
  }
  const removed = git(["tag", "-d", tag]);
  log(removed.code === 0
    ? `[promote] !!! retired the failed tag: ${tag} -> ${retired} (so it can never be a rollback target)`
    : `[promote] !!! recorded ${retired} but could not delete ${tag} (${removed.stderr}) — the next rollback would target it. Delete it by hand.`);
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  const sweep = opts.forceSweep ? null : await readSweepRow();
  // An UNREADABLE source is not the same as "no sweep has ever run" — one is a broken read
  // path, the other a verdict about the board — and reporting the second for the first sends
  // the operator looking in the wrong place.
  const verdict = opts.forceSweep
    ? { ok: true, reason: "forced", sha: null, detail: "--force-sweep: no sweep verdict was consulted" }
    : sweep.unreadable
      ? { ok: false, reason: "unreadable", sha: null, detail: `the sweep verdict could not be READ at all — ${sweep.source}` }
      : parseSweepVerdict(sweep.row, { branch: baseBranch, maxAgeMs: resolveMaxSweepAgeMs(env) });

  const headSha = gitOrThrow(["rev-parse", baseBranch]);
  const sha = verdict.ok && verdict.sha ? verdict.sha : headSha;

  const tags = gitOrThrow(["tag", "--list", "stable-*"]).split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  const tag = nextStableTag(stableTagDate(), tags);
  const rollbackTag = previousStableTag(tags, tag);

  const plan = buildPromotionPlan({
    sha,
    tag,
    previousTag: rollbackTag,
    stableCheckout,
    repoRoot: REPO_ROOT,
    boardUrl,
    dbPath,
    sweepSource: opts.forceSweep ? "SKIPPED" : sweep.source,
    sweepVerdict: verdict.detail,
    projectName,
    stablePort,
    dbUrl,
    logPath,
    forceSweep: opts.forceSweep,
  });

  if (opts.dryRun) {
    console.log("[promote] DRY RUN — nothing is tagged, built, started or written.\n");
    console.log(`  repo checkout    ${REPO_ROOT}${MAIN_CHECKOUT === REPO_ROOT ? "" : `   (main checkout: ${MAIN_CHECKOUT})`}`);
    console.log(`  stable checkout  ${stableCheckout}${existsSync(stableCheckout) ? "" : "   (DOES NOT EXIST)"}`);
    console.log(`  base branch      ${baseBranch} @ ${headSha}`);
    console.log(`  promote sha      ${sha}`);
    console.log(`  new tag          ${tag}`);
    console.log(`  rollback tag     ${rollbackTag ?? "<none — first promotion>"}`);
    console.log(`  board URL        ${boardUrl}`);
    console.log(`  operated DB      ${dbPath}  (read-only)`);
    console.log(`  stable DB pin    ${dbUrl}`);
    console.log(`  log file         ${logPath}`);
    console.log(`  sweep source     ${opts.forceSweep ? "SKIPPED (--force-sweep)" : sweep.source}`);
    console.log(`  sweep verdict    ${verdict.detail}\n`);
    console.log(verdict.ok ? "Steps that WOULD run:" : "This run would REFUSE at step 1. The steps it would otherwise run:");
    console.log(formatPlan(plan));
    if (!verdict.ok) {
      console.log(`\n[promote] WOULD REFUSE — ${verdict.detail} (reason: ${verdict.reason})`);
      console.log("[promote] --force-sweep would skip that check, loudly.");
      process.exit(1);
    }
    return;
  }

  if (opts.forceSweep) {
    log("[promote] ############################################################");
    log("[promote] # --force-sweep: the nightly full-sweep verdict was NOT    #");
    log("[promote] # consulted. Nothing has verified that master is green.    #");
    log("[promote] ############################################################");
  } else if (!verdict.ok) {
    fail(`${verdict.detail} (reason: ${verdict.reason}). Re-run once a green sweep exists, or --force-sweep.`);
  }

  // Refuse rather than create or repair the stable checkout: it is an operator artifact
  // (docs/two-boards.md §7), and a promotion into a dirty tree would destroy uncommitted work.
  if (!existsSync(stableCheckout)) {
    fail(`stable checkout ${stableCheckout} does not exist. Create it per docs/two-boards.md §7, or set KANBAN_STABLE_CHECKOUT.`);
  }
  const dirty = git(["status", "--porcelain"], stableCheckout);
  if (dirty.code !== 0) fail(`${stableCheckout} is not a git checkout (${dirty.stderr})`);
  if (dirty.stdout) fail(`stable checkout ${stableCheckout} is DIRTY:\n${dirty.stdout}`);

  log(`[promote] === promotion ${tag} -> ${sha} (from ${REPO_ROOT}) ===`);
  log(`[promote] sweep: ${verdict.detail} (source: ${opts.forceSweep ? "SKIPPED" : sweep.source})`);
  log(`[promote] rollback target: ${rollbackTag ?? "<none — first promotion>"}`);

  // A promotion must move the stable checkout FORWARD. See checkPromoteDirection.
  const stableHead = gitOrThrow(["rev-parse", "HEAD"], stableCheckout);
  const direction = checkPromoteDirection({
    stableHead,
    sha,
    shaIsDescendant: git(["merge-base", "--is-ancestor", stableHead, sha], stableCheckout).code === 0,
  });
  log(`[promote] direction: ${direction.detail}`);
  if (!direction.ok) fail(direction.detail);

  gitOrThrow(["tag", tag, sha]);
  log(`[promote] tagged ${tag} on ${sha}`);

  // The stable checkout may be a clone or a worktree of this repo. A clone needs the fetch to
  // see the tag at all; a worktree already shares the object store and the fetch is harmless.
  const fetched = git(["fetch", "origin", "--tags"], stableCheckout);
  log(`[promote] fetch origin --tags in ${stableCheckout}: exit ${fetched.code}${fetched.stderr ? ` (${fetched.stderr})` : ""}`);

  try {
    deployRef(tag);
    stopStableBoard();
    startStableBoard();
    const result = await smoke();
    if (result.ok) {
      log(`[promote] SMOKE PASSED — ${result.detail}`);
      log(`[promote] === ${tag} is live on ${boardUrl} ===`);
      return;
    }
    throw new Error(`smoke failed at ${result.failed}: ${result.detail}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[promote] !!! PROMOTION FAILED: ${reason}`);
    if (!rollbackTag) {
      log("[promote] !!! NO previous stable-* tag — cannot roll back automatically. The stable board may be DOWN or on the failed tag. Fix by hand.");
      process.exitCode = 1;
      return;
    }
    log(`[promote] !!! rolling back to ${rollbackTag}`);
    try {
      deployRef(rollbackTag, { hard: true });
      stopStableBoard();
      startStableBoard();
      const back = await smoke();
      if (back.ok) {
        log(`[promote] !!! ROLLED BACK to ${rollbackTag} — stable board healthy again (${back.detail})`);
        retireFailedTag(tag);
      } else {
        log(`[promote] !!! ROLLBACK to ${rollbackTag} did NOT come up healthy (${back.failed}: ${back.detail}) — the stable board needs a human.`);
      }
    } catch (rollbackErr) {
      log(`[promote] !!! ROLLBACK FAILED: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)} — the stable board needs a human.`);
    }
    // NOT process.exit(1): a detached child was just spawned, and exiting while its handle is
    // closing aborts the process on Windows with a libuv assertion — which replaces the exit
    // code a cron or the Sentinel reads with a crash code. Setting exitCode lets the loop drain.
    process.exitCode = 1;
    return;
  }
}

main().catch((err) => {
  log(`[promote] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});

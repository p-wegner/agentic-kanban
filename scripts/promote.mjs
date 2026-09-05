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
 *      READ-ONLY sqlite query. It never writes to that database. When the only thing missing is
 *      a CURRENT verdict it ASKS THE BOARD for one (`POST …/base-branch-health/reprobe`) and
 *      waits — see `planSweepAcquisition` for the trap that closes (#1044).
 *   2. tags `stable-YYYYMMDD` (`-2`, `-3`, … if the day already has one) on the green sha,
 *   3. in the stable checkout: fetch, fast-forward to the tag, install only if the lockfile
 *      moved, build, migrate, restart,
 *   4. smokes `/health`, `GET /api/projects` (non-empty) and one board-status call; on failure
 *      fast-forwards back to the previous `stable-*` tag, rebuilds, restarts and says so.
 *
 * Every step is appended to `<stable checkout>/.kanban/promote.log`, which is what the
 * Sentinel reads. The board this script STARTS logs somewhere else — `.kanban/board.log` — so a
 * server that writes for days cannot sit on top of the audit trail for a run that took minutes.
 *
 * Usage:
 *   node scripts/promote.mjs --dry-run        # print the resolved sha/tag/paths and every step; touch nothing
 *   node scripts/promote.mjs                  # promote (triggering + awaiting a sweep if one is needed)
 *   node scripts/promote.mjs --no-await-sweep # never trigger one; refuse when the recorded verdict is unusable
 *   node scripts/promote.mjs --force-sweep    # promote WITHOUT a green sweep (loud warning)
 *
 * Rehearsal: KANBAN_PROMOTE_FORCE_SMOKE_FAILURE=1 fails the promotion's smoke on purpose (one
 * shot — the rollback's smoke stays real), which is how the rollback half of #1014's acceptance
 * is exercised without breaking anything real.
 *
 * Env: KANBAN_STABLE_CHECKOUT, KANBAN_STABLE_PORT, KANBAN_PROMOTE_BOARD_URL, KANBAN_PROMOTE_DB,
 * KANBAN_PROMOTE_PROJECT, KANBAN_PROMOTE_BRANCH, KANBAN_PROMOTE_MAX_SWEEP_AGE_H,
 * KANBAN_PROMOTE_SWEEP_WAIT_MIN — all documented in `docs/env-vars.md`.
 */
import { spawn, spawnSync, execSync, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecSyncResult } from "./git-exec.mjs";
import { spawnSyncPnpm } from "./pnpm-exec.mjs";
import { parseNetstatListeners, planPortOwnerKill } from "./dev-port-guard.mjs";
import {
  BOARD_LOG_RELPATH,
  PROMOTE_LOG_RELPATH,
  SWEEP_POLL_INTERVAL_MS,
  buildPromotionPlan,
  checkPromoteDirection,
  formatPlan,
  isFreshSweepRow,
  nextStableTag,
  parseSweepVerdict,
  planSweepAcquisition,
  previousStableTag,
  resolveBoardUrl,
  resolveMaxSweepAgeMs,
  resolveOperatedDbPath,
  resolveProjectName,
  resolveStableCheckout,
  resolveSweepWaitMs,
  shouldForceSmokeFailure,
  shouldReinstall,
  stableTagDate,
} from "./promote-plan.mjs";
import { OUTCOMES_RELPATH, formatGateEvidence, parseOutcomeRows, summarizeGateEvidence } from "./promote-evidence.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const opts = {
  dryRun: args.includes("--dry-run"),
  forceSweep: args.includes("--force-sweep"),
  // #1044: the trigger-and-wait path is the DEFAULT, because the alternative is what turned
  // `--force-sweep` into the routine path. This flag restores the old refuse-immediately
  // behaviour for a caller that genuinely cannot wait tens of minutes.
  noAwaitSweep: args.includes("--no-await-sweep"),
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
const boardLogPath = join(stableCheckout, BOARD_LOG_RELPATH);

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
  // `viaHttp` is what makes the #1044 reprobe possible: the POST goes through this same board,
  // so a row that came from the sqlite FALLBACK carries a project id that is useless for asking.
  return { row: health?.latest ?? null, projectId: project.id, viaHttp: true, source: `board HTTP ${boardUrl}` };
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
    return { row: row ?? null, projectId: project.id, viaHttp: false, source: `read-only sqlite ${dbPath}` };
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
      return { row: null, projectId: null, viaHttp: false, source: `UNREADABLE (http: ${httpReason}; db: ${dbReason})`, unreadable: true };
    }
  }
}

// --- step 1b: ASK for the sweep this run needs (#1044) --------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `POST /api/projects/:id/base-branch-health/reprobe` — the board decides, and answers at once. */
async function requestReprobe(projectId) {
  const res = await fetch(`${boardUrl}/api/projects/${projectId}/base-branch-health/reprobe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`POST base-branch-health/reprobe -> ${res.status}`);
  return await res.json();
}

async function latestSweepRow(projectId) {
  const res = await fetch(`${boardUrl}/api/projects/${projectId}/base-branch-health?limit=1`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET base-branch-health -> ${res.status}`);
  const body = await res.json();
  return body?.latest ?? null;
}

/**
 * Trigger a sweep and wait for its verdict to LAND.
 *
 * The reprobe route is a synchronous decision over an asynchronous probe: it answers immediately
 * with whether a probe started, and the verdict appears minutes later as a NEW `base_branch_health`
 * row. So this polls for a row that is a different observation than the one we already read
 * (`isFreshSweepRow`) — not for "green", and not for "a row exists".
 *
 * A request the board declined (`gate_running`, `host_saturated`) is retried on each poll rather
 * than treated as failure: those are transient states, and the whole point is to wait them out.
 * On expiry this returns nothing and the caller refuses exactly as it would have without the
 * trigger — a promotion never proceeds because a wait ran out.
 */
async function acquireFreshSweep(projectId, previousRow, waitMs) {
  const deadline = Date.now() + waitMs;
  let probing = false;
  let lastNote = 0;
  log(`[promote] requesting a fresh base-branch sweep for project ${projectId} (waiting up to ${Math.round(waitMs / 60_000)} min)`);
  while (Date.now() < deadline) {
    if (!probing) {
      try {
        const answer = await requestReprobe(projectId);
        probing = Boolean(answer?.started || answer?.joinedRunningProbe || answer?.skippedReason === "probe_in_flight");
        log(
          `[promote] reprobe: started=${answer?.started === true} ` +
            `${answer?.skippedReason ? `skipped=${answer.skippedReason} ` : ""}` +
            `${answer?.joinedRunningProbe ? "(a probe was already running) " : ""}` +
            `${probing ? "— a probe is running; waiting for its verdict" : "— nothing is probing yet; will ask again"}`,
        );
      } catch (e) {
        log(`[promote] reprobe request failed: ${e instanceof Error ? e.message : String(e)} — retrying`);
      }
    }
    await sleep(SWEEP_POLL_INTERVAL_MS);
    try {
      const row = await latestSweepRow(projectId);
      if (isFreshSweepRow(row, previousRow)) {
        log(`[promote] fresh sweep landed: ${row.outcome} on ${row.sha} at ${row.createdAt ?? row.created_at}`);
        return { row };
      }
    } catch (e) {
      log(`[promote] could not re-read the sweep row: ${e instanceof Error ? e.message : String(e)} — retrying`);
    }
    const elapsed = Date.now() - (deadline - waitMs);
    if (elapsed - lastNote >= 120_000) {
      lastNote = elapsed;
      log(`[promote] still waiting for the sweep verdict (${Math.round(elapsed / 60_000)} min elapsed of ${Math.round(waitMs / 60_000)})`);
    }
  }
  return { row: null, reason: `no fresh verdict within ${Math.round(waitMs / 60_000)} min` };
}

// --- accumulated-gate evidence (#1045) -------------------------------------------------------

/**
 * Read the test-impact ledger the pre-merge gates write into and summarize what has accumulated
 * since the last sweep. PRINTED ONLY — see `promote-evidence.mjs` for why it authorizes nothing.
 */
function readGateEvidence(sinceIso) {
  const ledgerPath = join(MAIN_CHECKOUT, OUTCOMES_RELPATH);
  try {
    const rows = parseOutcomeRows(readFileSync(ledgerPath, "utf8"));
    return summarizeGateEvidence(rows, { sinceIso, ledgerPath });
  } catch (e) {
    return { ledgerPath, unreadable: e instanceof Error ? e.message : String(e) };
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
 * goes to `<stable>/.kanban/board.log`, NOT to the promote log — the started process keeps that
 * fd open for days, and a long-lived writer does not belong on the run-by-run audit trail the
 * Sentinel reads (see {@link BOARD_LOG_RELPATH} for what that cost once). `windowsHide` and
 * `detached`+`unref` keep it from flashing a window or dying with this script.
 */
function startStableBoard() {
  const cli = join(stableCheckout, "packages", "server", "dist", "cli", "index.js");
  if (!existsSync(cli)) throw new Error(`built CLI missing: ${cli} (did the build step run?)`);
  mkdirSync(dirname(boardLogPath), { recursive: true });
  const out = openSync(boardLogPath, "a");
  const child = spawn(process.execPath, [cli, "dev", "--port", String(stablePort), "--no-open"], {
    cwd: stableCheckout,
    env: { ...process.env, KANBAN_DB_URL: dbUrl, KANBAN_HOST: "127.0.0.1", PORT: String(stablePort) },
    windowsHide: true,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  log(`[promote] started stable board pid ${child.pid} on ${stablePort} (cwd ${stableCheckout}, output -> ${boardLogPath})`);
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

/**
 * The stable checkout's HEAD, or null when it cannot be read (missing checkout, not a git dir).
 * Needed BEFORE the promotion's own existence check because the #1044 trap is visible only in
 * the DIRECTION between that HEAD and the green sweep's sha — a null here just means the
 * acquisition decision is made without that half, which is the conservative side.
 */
function readStableHead() {
  if (!existsSync(stableCheckout)) return null;
  const r = git(["rev-parse", "HEAD"], stableCheckout);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

function directionFor(sha, stableHead) {
  if (!stableHead || !sha) return null;
  return checkPromoteDirection({
    stableHead,
    sha,
    shaIsDescendant: git(["merge-base", "--is-ancestor", stableHead, sha], stableCheckout).code === 0,
  });
}

async function main() {
  // An UNREADABLE source is not the same as "no sweep has ever run" — one is a broken read
  // path, the other a verdict about the board — and reporting the second for the first sends
  // the operator looking in the wrong place.
  const verdictFor = (sweep) =>
    opts.forceSweep
      ? { ok: true, reason: "forced", sha: null, detail: "--force-sweep: no sweep verdict was consulted" }
      : sweep.unreadable
        ? { ok: false, reason: "unreadable", sha: null, detail: `the sweep verdict could not be READ at all — ${sweep.source}` }
        : parseSweepVerdict(sweep.row, { branch: baseBranch, maxAgeMs: resolveMaxSweepAgeMs(env) });

  let sweep = opts.forceSweep ? null : await readSweepRow();
  let verdict = verdictFor(sweep);

  const stableHead = readStableHead();
  const acquisition = planSweepAcquisition({
    verdict,
    direction: directionFor(verdict.ok ? verdict.sha : null, stableHead),
    forceSweep: opts.forceSweep,
    awaitSweep: !opts.noAwaitSweep,
    // Both halves are required: an id to ask ABOUT, and a board that ANSWERED. The sqlite
    // fallback yields the first without the second, and asking a board that is not there just
    // burns the whole wait before refusing anyway.
    canRequest: Boolean(sweep?.projectId && sweep?.viaHttp),
  });

  // The trigger happens BEFORE the dry-run report only in a real run — a dry run must touch
  // nothing, so it says what it WOULD do and stops there.
  if (acquisition.request && !opts.dryRun) {
    log(`[promote] sweep acquisition: ${acquisition.detail}`);
    const acquired = await acquireFreshSweep(sweep.projectId, sweep.row, resolveSweepWaitMs(env));
    if (acquired.row) {
      sweep = { ...sweep, row: acquired.row, source: `${sweep.source} (sweep TRIGGERED by this run)` };
      // Re-parsed, not trusted: a sweep this run asked for is judged by exactly the same rules
      // as one that happened on its own clock, so a red or timed-out probe still refuses.
      verdict = verdictFor(sweep);
    } else {
      log(`[promote] the requested sweep did not land (${acquired.reason}) — falling through to the recorded verdict`);
    }
  }

  const headSha = gitOrThrow(["rev-parse", baseBranch]);
  const sha = verdict.ok && verdict.sha ? verdict.sha : headSha;
  const gateEvidence = readGateEvidence(verdict.at ?? null);

  const tags = gitOrThrow(["tag", "--list", "stable-*"]).split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  // A tag RETIRED by a failed promotion (see retireFailedTag) is gone from the `stable-*` list,
  // so the name would otherwise be handed straight back to the next run — pointing a second,
  // different sha at a name a post-mortem already knows. Retired names stay TAKEN; they are not,
  // however, rollback candidates, which is the whole point of retiring them.
  const retiredNames = gitOrThrow(["tag", "--list", "failed-promotion-stable-*"])
    .split(/\r?\n/)
    .map((t) => t.trim().replace(/^failed-promotion-/, ""))
    .filter(Boolean);
  const tag = nextStableTag(stableTagDate(), [...tags, ...retiredNames]);
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
    boardLogPath,
    forceSweep: opts.forceSweep,
    sweepAcquisition: acquisition,
    gateEvidence: formatGateEvidence(gateEvidence),
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
    console.log(`  board log        ${boardLogPath}`);
    console.log(`  sweep source     ${opts.forceSweep ? "SKIPPED (--force-sweep)" : sweep.source}`);
    console.log(`  sweep verdict    ${verdict.detail}`);
    // #1044: the direction against the stable checkout is the OTHER refusal, and it was invisible
    // here — a dry run could print a clean plan for a run that refuses at `behind`.
    const dryDirection = directionFor(sha, stableHead);
    console.log(`  direction        ${dryDirection ? dryDirection.detail : "not checked (no readable stable HEAD)"}`);
    console.log(`  sweep plan       ${acquisition.detail}`);
    // #1045: printed beside the verdict it is weaker than, and labelled as such.
    console.log(`  gate evidence    ${formatGateEvidence(gateEvidence)}\n`);

    const wouldRefuse = !acquisition.request && (!verdict.ok || (dryDirection && !dryDirection.ok));
    console.log(
      acquisition.request
        ? "This run would TRIGGER a sweep first, then run these steps on its verdict (refusing if it is not green):"
        : wouldRefuse
          ? "This run would REFUSE. The steps it would otherwise run:"
          : "Steps that WOULD run:",
    );
    console.log(formatPlan(plan));
    if (wouldRefuse) {
      const why = !verdict.ok ? `${verdict.detail} (reason: ${verdict.reason})` : dryDirection.detail;
      console.log(`\n[promote] WOULD REFUSE — ${why}`);
      console.log(`[promote] ${acquisition.reason === "disabled" ? "drop --no-await-sweep to trigger a sweep instead, or " : ""}--force-sweep would skip the sweep check, loudly.`);
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
    // Name whether this run TRIED to get evidence. "Re-run once a green sweep exists" is bad
    // advice when the run just spent 40 minutes asking for one — that is a board problem, and
    // reading it as "wait for the nightly" is what sends an operator to --force-sweep (#1044).
    const tried = acquisition.request
      ? "This run requested a fresh sweep and it did not land — check the board's base-branch probe."
      : `No sweep was requested: ${acquisition.detail}`;
    fail(`${verdict.detail} (reason: ${verdict.reason}). ${tried} Or promote deliberately with --force-sweep.`);
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
  // #1045 — into the audit trail the Sentinel reads, as context for the verdict above. It is
  // never what authorized this promotion; the sweep line is.
  log(`[promote] gate evidence: ${formatGateEvidence(gateEvidence)}`);
  log(`[promote] rollback target: ${rollbackTag ?? "<none — first promotion>"}`);

  // A promotion must move the stable checkout FORWARD. See checkPromoteDirection. Re-read rather
  // than reusing the pre-acquisition `stableHead`: minutes may have passed waiting for a sweep.
  const direction = directionFor(sha, gitOrThrow(["rev-parse", "HEAD"], stableCheckout));
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

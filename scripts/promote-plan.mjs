/**
 * Pure half of the promotion script (#1014) — everything that decides, nothing that acts.
 *
 * `scripts/promote.mjs` is the driver: it talks to git, to the board's HTTP API (or its
 * database), to pnpm and to a real server process. Every decision it makes is made HERE, in
 * functions that take their inputs as arguments and return values, so the interesting parts
 * (does this sweep verdict permit a promotion, what is the tag called, what would the run do)
 * are testable without promoting anything. That split is the whole reason this file exists —
 * the ticket's own acceptance is "a dry run prints the sha, tag and each step", and a dry run
 * is exactly this module rendered to stdout.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Default location of the stable checkout: a sibling of this one. */
export const DEFAULT_STABLE_CHECKOUT_DIRNAME = "agentic-kanban-stable";

/** Where every run appends its log, relative to the STABLE checkout. */
export const PROMOTE_LOG_RELPATH = join(".kanban", "promote.log");

/**
 * Where the BOARD the promotion starts sends its stdout/stderr — deliberately NOT the promote log.
 *
 * These are two different kinds of file with two different lifetimes. The promote log is a short,
 * append-only audit trail of discrete runs, and it is what the Sentinel reads (`docs/two-boards.md`
 * §8). The board log is the continuous output of a server process that then holds its fd open for
 * days. Pointing both at one file puts two long-lived writers on the Sentinel's evidence, and the
 * promotion's own record is the half that loses: on 2026-09-05 the 10:02 run's header, sweep,
 * direction, tag and fast-forward lines were absent from `promote.log` while the outgoing board's
 * `[loop-lag]` output for the same minutes was present — the promotion demonstrably ran (git and
 * its own `SMOKE PASSED` line prove it), but its opening record was not there to read.
 *
 * The loss mechanism was never proven, which is exactly why the fix is separation rather than a
 * cleverer write: a run's audit trail should not depend on how a server process happens to buffer.
 */
export const BOARD_LOG_RELPATH = join(".kanban", "board.log");

/**
 * How old a green sweep may be and still authorize a promotion.
 *
 * The sweep is nightly, so a verdict older than a bit more than a day means the sweep did not
 * run — and "the last recorded sweep was green" is then a statement about a master that has
 * since moved, not about the sha being promoted. 36h leaves room for a late or skipped night
 * without silently promoting on a week-old verdict.
 */
export const DEFAULT_MAX_SWEEP_AGE_HOURS = 36;

/**
 * How long a promotion will WAIT for a sweep it triggered itself (#1044).
 *
 * The probe clones, installs and runs the project's full verify, so the honest number is tens
 * of minutes, not seconds — that wait IS the evidence. It is capped rather than unbounded so a
 * promotion started from a cron cannot sit forever on a probe that never lands; on expiry the
 * run refuses exactly as it would have without the trigger.
 */
export const DEFAULT_SWEEP_WAIT_MINUTES = 40;

/** How often the run re-reads `base_branch_health` while waiting for its sweep. */
export const SWEEP_POLL_INTERVAL_MS = 15_000;

/**
 * Sweep-verdict refusals a FRESH sweep would actually resolve.
 *
 * Deliberately excludes two:
 * - `red` — master is broken. Re-probing the same tree to see whether it is still broken is not
 *   evidence-gathering, it is rolling dice, and a promotion is the wrong place to do it.
 * - `unreadable` — the board did not answer, and the reprobe goes through that same board. There
 *   is nothing to ask.
 */
export const REPROBEABLE_SWEEP_REASONS = Object.freeze([
  "no-sweep",
  "stale",
  "not-an-answer",
  "no-sha",
  "wrong-branch",
]);

/** Board API the sweep row is read from when a board is up. */
export const DEFAULT_BOARD_URL = "http://127.0.0.1:3001";

/** The project whose base-branch health decides the promotion. */
export const DEFAULT_PROJECT_NAME = "agentic-kanban";

export function resolveStableCheckout({ env = process.env, repoRoot = process.cwd() } = {}) {
  if (env.KANBAN_STABLE_CHECKOUT) return resolve(env.KANBAN_STABLE_CHECKOUT);
  return resolve(repoRoot, "..", DEFAULT_STABLE_CHECKOUT_DIRNAME);
}

export function resolveBoardUrl(env = process.env) {
  return (env.KANBAN_PROMOTE_BOARD_URL || DEFAULT_BOARD_URL).replace(/\/+$/, "");
}

/**
 * The database the STABLE board is pinned to (`docs/two-boards.md` §2) — the fallback read
 * path when no board answers HTTP. Read-only, always: this script never writes to it.
 */
export function resolveOperatedDbPath({ env = process.env, homeDir = homedir() } = {}) {
  if (env.KANBAN_PROMOTE_DB) return resolve(env.KANBAN_PROMOTE_DB);
  return join(homeDir, ".agentic-kanban", "kanban.db");
}

export function resolveMaxSweepAgeMs(env = process.env) {
  const raw = Number(env.KANBAN_PROMOTE_MAX_SWEEP_AGE_H);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_SWEEP_AGE_HOURS;
  return hours * 60 * 60 * 1000;
}

export function resolveProjectName(env = process.env) {
  return env.KANBAN_PROMOTE_PROJECT || DEFAULT_PROJECT_NAME;
}

export function resolveSweepWaitMs(env = process.env) {
  const raw = Number(env.KANBAN_PROMOTE_SWEEP_WAIT_MIN);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SWEEP_WAIT_MINUTES;
  return minutes * 60 * 1000;
}

/** `YYYYMMDD` in LOCAL time — the tag names the operator's day, not UTC's. */
export function stableTagDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** `{ tag, date, ordinal }` for a `stable-YYYYMMDD[-N]` tag, or null when it is not one. */
export function parseStableTag(tag) {
  const m = /^stable-(\d{8})(?:-(\d+))?$/.exec(String(tag).trim());
  if (!m) return null;
  return { tag: String(tag).trim(), date: m[1], ordinal: m[2] ? Number(m[2]) : 1 };
}

/**
 * The tag this promotion should create: `stable-YYYYMMDD`, or `-2`, `-3`, … when the day
 * already has one. Two promotions on one day is normal (a morning promotion and an afternoon
 * fix), and silently moving an existing tag would erase the rollback target.
 */
export function nextStableTag(dateStamp, existingTags = []) {
  const taken = new Set(existingTags.map((t) => String(t).trim()));
  const base = `stable-${dateStamp}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`no free stable tag for ${dateStamp} after 999 attempts`);
}

/** Newest-first ordering over `stable-*` tags: by date, then by same-day ordinal. */
export function sortStableTags(tags = []) {
  return tags
    .map(parseStableTag)
    .filter(Boolean)
    .sort((a, b) => (a.date === b.date ? b.ordinal - a.ordinal : b.date.localeCompare(a.date)))
    .map((t) => t.tag);
}

/**
 * The tag a failed promotion rolls back to: the newest `stable-*` that is not the one this
 * run just created. `null` when there is none — a first promotion has nothing to fall back to,
 * and the driver must say so rather than pretend it can recover.
 */
export function previousStableTag(existingTags = [], excludeTag = null) {
  return sortStableTags(existingTags).find((t) => t !== excludeTag) ?? null;
}

/**
 * Does this `base_branch_health` row authorize a promotion?
 *
 * The row is the one the nightly full sweep writes through `recordBaseBranchHealth`
 * (`packages/server/src/services/base-branch-health.service.ts`, which then hands the same
 * outcome to `recordBaseSweepOutcome`). Its `outcome` has four values and only two of them
 * are VERDICTS: `green`/`red` mean the verify script ran to completion, `timeout`/`unverified`
 * mean the probe was cut off or never got far enough — see `isBaseHealthAnswer`. A non-answer
 * must refuse, not promote: it says nothing about master, and treating it as green is exactly
 * the false confidence #935 documents in the other direction.
 */
export function parseSweepVerdict(row, { branch = "master", nowMs = Date.now(), maxAgeMs = DEFAULT_MAX_SWEEP_AGE_HOURS * 3600_000 } = {}) {
  if (!row) {
    return { ok: false, reason: "no-sweep", detail: "no base_branch_health row has ever been recorded for this project" };
  }
  const sha = row.sha ?? null;
  const outcome = row.outcome ?? null;
  const at = row.createdAt ?? row.created_at ?? null;
  const rowBranch = row.branch ?? null;
  const stamp = `sha ${sha ?? "<none>"} branch ${rowBranch ?? "<none>"} verdict ${outcome ?? "<none>"} at ${at ?? "<unknown>"}`;

  if (rowBranch && rowBranch !== branch) {
    return { ok: false, reason: "wrong-branch", sha, outcome, at, branch: rowBranch, detail: `last sweep was on '${rowBranch}', not '${branch}' — ${stamp}` };
  }
  if (outcome !== "green" && outcome !== "red") {
    return { ok: false, reason: "not-an-answer", sha, outcome, at, branch: rowBranch, detail: `last sweep produced no verdict (${outcome}) — ${stamp}` };
  }
  if (outcome === "red") {
    return { ok: false, reason: "red", sha, outcome, at, branch: rowBranch, detail: `last sweep was RED — ${stamp}`, message: row.message ?? null };
  }
  const ageMs = at ? nowMs - Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ageMs)) {
    return { ok: false, reason: "undated", sha, outcome, at, branch: rowBranch, detail: `green sweep has no readable timestamp — ${stamp}` };
  }
  if (ageMs > maxAgeMs) {
    const hours = (ageMs / 3600_000).toFixed(1);
    return { ok: false, reason: "stale", sha, outcome, at, ageMs, branch: rowBranch, detail: `last green sweep is ${hours}h old (limit ${(maxAgeMs / 3600_000).toFixed(1)}h) — ${stamp}` };
  }
  if (!sha) {
    return { ok: false, reason: "no-sha", outcome, at, branch: rowBranch, detail: `green sweep row carries no sha — ${stamp}` };
  }
  return { ok: true, reason: "green", sha, outcome, at, ageMs, branch: rowBranch, detail: `green sweep — ${stamp}` };
}

/**
 * Is this `base_branch_health` row a DIFFERENT observation from the one we started with?
 *
 * The wait after a reprobe cannot key on "a row exists" (one always does) or on the outcome
 * (a second green looks identical to the first). Identity is the pair (sha, timestamp): the
 * probe inserts, never upserts, so a landed verdict always changes at least the timestamp.
 */
export function isFreshSweepRow(row, previous) {
  if (!row) return false;
  const stamp = (r) => `${r?.sha ?? ""}@${r?.createdAt ?? r?.created_at ?? ""}`;
  if (!previous) return true;
  return stamp(row) !== stamp(previous);
}

/**
 * Should this run TRIGGER the sweep it needs, instead of refusing and sending the operator to
 * `--force-sweep`? (#1044)
 *
 * The trap this exists to close: `--force-sweep` promotes the branch TIP, which moves the stable
 * checkout AHEAD of the last recorded sweep sha. The next honest promotion then reads a green
 * verdict for an ANCESTOR of what is already deployed, `checkPromoteDirection` correctly refuses
 * it as `behind`, and the only way forward is another `--force-sweep`. Two runs on 2026-09-05
 * went exactly that way. So each forced run made the next honest one structurally impossible, and
 * the loud escape hatch was becoming the routine path — which is how it stops being loud.
 *
 * The fix is the shape the ticket calls "let promote trigger the sweep it needs": when the only
 * thing missing is a CURRENT verdict, ask the board for one (`POST …/base-branch-health/reprobe`)
 * and wait for it. Waiting tens of minutes for real evidence is the intended trade; skipping the
 * evidence because the evidence was unreachable is not.
 *
 * It is a REQUEST for evidence, never a substitute for it: whatever the fresh sweep says is then
 * run through `parseSweepVerdict` exactly as a sweep that happened on its own clock, so a red or
 * timed-out probe still refuses.
 *
 * @param {object} p
 * @param {{ok: boolean, reason: string, sha?: string|null}} p.verdict  from {@link parseSweepVerdict}
 * @param {{ok: boolean, reason: string}|null} p.direction  from {@link checkPromoteDirection}, when a stable HEAD could be read
 * @param {boolean} p.forceSweep   `--force-sweep` — consults no verdict at all, so nothing to acquire
 * @param {boolean} p.awaitSweep   false with `--no-await-sweep`: refuse as before rather than wait
 * @param {boolean} p.canRequest   is there a board to POST the reprobe to? (a sqlite-fallback read has no project id)
 */
export function planSweepAcquisition({ verdict, direction = null, forceSweep = false, awaitSweep = true, canRequest = true } = {}) {
  if (forceSweep) {
    return { request: false, reason: "force-sweep", detail: "--force-sweep consults no sweep verdict, so there is nothing to acquire" };
  }

  // Why this run needs a fresh sweep — or null when it does not.
  let need = null;
  if (verdict?.ok) {
    // The #1044 trap itself. The verdict is green and usable; it is just about a commit the
    // stable checkout has already moved past, which is what a forced promotion leaves behind.
    if (direction && !direction.ok && direction.reason === "behind") {
      need = `the last green sweep (${verdict.sha ?? "<no sha>"}) is BEHIND what the stable checkout already runs — a promotion on it would be a silent no-op`;
    }
  } else if (REPROBEABLE_SWEEP_REASONS.includes(verdict?.reason)) {
    need = `no usable sweep verdict (${verdict.reason})`;
  } else if (verdict?.reason === "red") {
    return { request: false, reason: "red", detail: "the last sweep was RED — master is broken; re-probing it is not evidence-gathering. Fix master, or promote deliberately with --force-sweep." };
  } else if (verdict?.reason === "unreadable") {
    return { request: false, reason: "unreadable", detail: "the sweep verdict could not be read at all, and the reprobe goes through the same board — nothing to ask" };
  } else {
    return { request: false, reason: "not-reprobeable", detail: `refusal '${verdict?.reason ?? "<none>"}' is not something a fresh sweep would resolve` };
  }

  if (!need) return { request: false, reason: "verdict-usable", detail: "the recorded sweep verdict already authorizes this promotion" };
  if (!awaitSweep) {
    return { request: false, reason: "disabled", detail: `${need} — but --no-await-sweep was passed, so this run refuses instead of waiting for one` };
  }
  if (!canRequest) {
    return { request: false, reason: "no-board", detail: `${need} — and no board answered, so no sweep can be requested. Start the board, or --force-sweep.` };
  }
  return { request: true, reason: "acquire", detail: `${need} — requesting a fresh sweep and waiting for its verdict` };
}

/** A lockfile change is the only thing that justifies re-installing in the stable checkout. */
export function shouldReinstall(lockBefore, lockAfter) {
  return String(lockBefore ?? "") !== String(lockAfter ?? "");
}

/**
 * The ordered steps of one promotion, as data. The dry run prints exactly this; the real run
 * executes exactly this, in this order.
 */
export function buildPromotionPlan({
  sha,
  tag,
  previousTag,
  stableCheckout,
  repoRoot,
  boardUrl,
  dbPath,
  sweepSource,
  sweepVerdict,
  projectName,
  stablePort,
  dbUrl,
  logPath,
  boardLogPath = null,
  forceSweep = false,
  sweepAcquisition = null,
  gateEvidence = null,
}) {
  const step1 = {
    n: 1,
    title: forceSweep ? "sweep check SKIPPED (--force-sweep)" : "check the last full sweep on master was green",
    detail: forceSweep
      ? "WARNING: --force-sweep — promoting WITHOUT a green verdict from base_branch_health"
      : `read via ${sweepSource} (board ${boardUrl}, db ${dbPath}) for project '${projectName}': ${sweepVerdict}`,
  };
  if (sweepAcquisition?.request) {
    step1.title = "TRIGGER a fresh sweep, wait for its verdict, then check it";
    step1.detail = `${step1.detail}\n      -> ${sweepAcquisition.detail}`;
  }
  // The accumulated-gate evidence is printed HERE, next to the verdict it is weaker than, and
  // nowhere else — it decides nothing (#1045).
  if (gateEvidence) step1.detail = `${step1.detail}\n      gate evidence (does not authorize a promotion): ${gateEvidence}`;
  return [
    step1,
    { n: 2, title: `tag ${tag} on ${sha}`, detail: `git -C ${repoRoot} tag ${tag} ${sha}   (rollback target: ${previousTag ?? "<none — first promotion>"})` },
    { n: 3, title: "stable checkout: fetch + fast-forward", detail: `git -C ${stableCheckout} fetch origin --tags && git -C ${stableCheckout} merge --ff-only ${tag}` },
    { n: 4, title: "install only if pnpm-lock.yaml changed", detail: `pnpm install -r --prefer-offline in ${stableCheckout}` },
    { n: 5, title: "build", detail: `pnpm build in ${stableCheckout}` },
    { n: 6, title: "run migrations", detail: `pnpm --filter agentic-kanban db:migrate in ${stableCheckout} with KANBAN_DB_URL=${dbUrl}` },
    { n: 7, title: `restart the stable board on port ${stablePort}`, detail: `stop the port-${stablePort} listener whose command line belongs to ${stableCheckout} (signature only, never kill-all-node), then spawn packages/server/dist/cli/index.js` },
    { n: 8, title: "smoke", detail: `GET ${boardUrl}/health, GET ${boardUrl}/api/projects (non-empty), GET ${boardUrl}/api/issues?projectId=<${projectName}> (the get_board_status equivalent)` },
    { n: 9, title: "on smoke failure: roll back", detail: previousTag ? `fast-forward ${stableCheckout} to ${previousTag}, rebuild, restart, report loudly` : "NO previous stable-* tag exists — a failed smoke cannot be rolled back automatically; the run reports that loudly" },
    { n: 10, title: "logs", detail: `promotion audit trail: ${logPath}${boardLogPath ? `  ·  started board's stdout/stderr: ${boardLogPath}` : ""}` },
  ];
}

export function formatPlan(plan) {
  return plan.map((s) => `  ${String(s.n).padStart(2, " ")}. ${s.title}\n      ${s.detail}`).join("\n");
}

/**
 * The rehearsal seam for #1014's second acceptance case: "a forced smoke failure rolls back to
 * the previous tag and the stable board answers /health afterwards".
 *
 * Without a seam the only way to exercise the rollback half is to break something real (point
 * the board URL at a dead port, ship a broken build), which either takes the board down for the
 * duration or edits the script's logic mid-run. So the driver reads this env var — and it is
 * deliberately ONE-SHOT: it fails the PROMOTION's smoke and is then consumed, so the ROLLBACK's
 * smoke is a genuine check of the rolled-back board rather than a second forced failure. A
 * seam that failed both would make the rollback unverifiable, which is the whole point.
 */
export function shouldForceSmokeFailure(env = process.env) {
  const raw = env.KANBAN_PROMOTE_FORCE_SMOKE_FAILURE;
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * May this sha be promoted over what the stable checkout currently has?
 *
 * The sha comes from the last GREEN sweep, which is by construction older than master's tip —
 * and after a hand-made cutover the stable checkout can already sit on a LATER commit. Deploying
 * an ancestor then does nothing at all: `git merge --ff-only <ancestor>` reports "Already up to
 * date" and exits 0, so the run would tag, rebuild, restart, smoke green and announce that tag as
 * live while the checkout still runs something else entirely. A promotion that lies about what is
 * deployed is worse than one that refuses.
 *
 * @param {object} p
 * @param {string} p.stableHead   the stable checkout's current HEAD sha
 * @param {string} p.sha          the sha this promotion would deploy
 * @param {boolean} p.shaIsDescendant  is `stableHead` an ancestor of `sha`? (git decides)
 */
export function checkPromoteDirection({ stableHead, sha, shaIsDescendant }) {
  if (!stableHead || !sha) return { ok: true, reason: "unknown", detail: "could not read one of the shas — not blocking" };
  if (stableHead === sha) return { ok: true, reason: "same", detail: `stable checkout is already at ${sha}` };
  if (shaIsDescendant) return { ok: true, reason: "forward", detail: `${sha} is ahead of the stable checkout's ${stableHead}` };
  return {
    ok: false,
    reason: "behind",
    detail:
      `the sha to promote (${sha}) is NOT a descendant of the stable checkout's HEAD (${stableHead}) — ` +
      `deploying it would be a silent no-op that tags a version which is not what runs. ` +
      `Promote a sha that is ahead (a newer green sweep, or --force-sweep to tag ${"the branch tip"}).`,
  };
}

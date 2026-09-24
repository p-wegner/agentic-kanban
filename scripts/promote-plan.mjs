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
  // #1231 — a green the runner itself reported as a NARROWED run. Since #1231 the probe's child
  // env is an allowlist, so a fresh sweep runs full; the scoped row is the one thing a re-probe
  // genuinely resolves.
  "scoped",
]);

/** Board API the sweep row is read from when a board is up. */
export const DEFAULT_BOARD_URL = "http://127.0.0.1:3001";

/** The project whose base-branch health decides the promotion. */
export const DEFAULT_PROJECT_NAME = "agentic-kanban";

/**
 * Every flag `promote.mjs` understands. `--reason` is the one that takes a value; the rest are
 * bare switches. `--help`/`-h` are real flags here (not "whatever falls through") so a typo of
 * one word never lands anyone in the promotion lane.
 */
export const KNOWN_PROMOTE_FLAGS = Object.freeze([
  "--dry-run",
  "--force-sweep",
  "--no-await-sweep",
  "--recover",
  "--with-migration",
  "--restart-stable",
  "--reason",
  "--help",
  "-h",
]);

/**
 * Strict argv parsing (#1222). The old parser (`args.includes("--flag")`) silently ignores any
 * token it does not recognise, so `--help`, `--dryrun`, `--dry_run`, or a misspelling of any
 * real flag falls through to the FULL promotion lane — the single most dangerous default for a
 * typo, since the operator's intent in every one of those cases is "ask me something / change
 * nothing" and the script did the opposite.
 *
 * Collects every `--`/`-`-prefixed token and diffs it against {@link KNOWN_PROMOTE_FLAGS}.
 * Returns `{ ok: false, unknown }` on the first pass rather than throwing, so the caller can
 * print the known-flags list and refuse loudly instead of a stack trace.
 */
export function parsePromoteArgv(argv = []) {
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-")) continue; // a value (e.g. --reason's argument), not a flag
    if (token === "--reason") {
      i++; // consume its value, whatever it is — not itself a flag to validate
      continue;
    }
    if (!KNOWN_PROMOTE_FLAGS.includes(token)) unknown.push(token);
  }
  if (unknown.length > 0) {
    return { ok: false, unknown, knownFlags: [...KNOWN_PROMOTE_FLAGS] };
  }

  const help = argv.includes("--help") || argv.includes("-h");
  const reasonIndex = argv.indexOf("--reason");
  const reason = reasonIndex >= 0 && argv[reasonIndex + 1] && !argv[reasonIndex + 1].startsWith("-") ? argv[reasonIndex + 1] : null;

  return {
    ok: true,
    help,
    dryRun: argv.includes("--dry-run"),
    forceSweep: argv.includes("--force-sweep"),
    noAwaitSweep: argv.includes("--no-await-sweep"),
    recover: argv.includes("--recover"),
    withMigration: argv.includes("--with-migration"),
    restartStable: argv.includes("--restart-stable"),
    reason,
  };
}

/** Rendered once for `--help`/`-h` and for a refusal on an unknown flag. */
export function formatPromoteUsage() {
  return [
    "Usage:",
    "  node scripts/promote.mjs --dry-run        # print the resolved sha/tag/paths and every step; touch nothing",
    "  node scripts/promote.mjs                  # promote (triggering + awaiting a sweep if one is needed)",
    "  node scripts/promote.mjs --no-await-sweep # never trigger one; refuse when the recorded verdict is unusable",
    '  node scripts/promote.mjs --recover --reason "fix the leak"   # FAST LANE: no sweep (#1054)',
    "  node scripts/promote.mjs --force-sweep    # promote WITHOUT a green sweep (loud warning)",
    "  node scripts/promote.mjs --restart-stable # RESTART-ONLY (#1202): after a reboot, start the",
    "                                             # already-deployed tag if the port is free; refuse",
    "                                             # (exit 2) without spawning if it is already held.",
    "                                             # No tag, no fast-forward, no build, no sweep. Also",
    "                                             # `pnpm stable:start`.",
    "  node scripts/promote.mjs --with-migration # (with --recover) ack that the delta includes a migration",
    '  node scripts/promote.mjs --reason "..."   # (with --recover) why this bypassed the sweep',
    "  node scripts/promote.mjs --help           # this text",
  ].join("\n");
}

/** One line naming the known flags, for an unknown-flag refusal. */
export function formatUnknownFlagRefusal(unknown) {
  return (
    `unknown flag${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}\n` +
    `known flags: ${KNOWN_PROMOTE_FLAGS.join(", ")}\n\n${formatPromoteUsage()}`
  );
}

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
 *
 * `scope` (#1231) is what the verify script's own `tests` step said it RAN. A green whose scope
 * is present and not `full` is a scoped verdict — the sweep checked a subset — and is refused
 * (`scoped`). A NULL scope is accepted: every row written before the column existed carries
 * one, and so does any project whose verify script has no `[gate:step]` contract; the detail
 * says `scope <none: unknown, accepted>` so the reader sees the gap rather than a claim.
 */
export function parseSweepVerdict(row, { branch = "master", nowMs = Date.now(), maxAgeMs = DEFAULT_MAX_SWEEP_AGE_HOURS * 3600_000 } = {}) {
  if (!row) {
    return { ok: false, reason: "no-sweep", detail: "no base_branch_health row has ever been recorded for this project" };
  }
  const sha = row.sha ?? null;
  const outcome = row.outcome ?? null;
  const at = row.createdAt ?? row.created_at ?? null;
  const rowBranch = row.branch ?? null;
  const scope = row.scope ?? null;
  const stamp = `sha ${sha ?? "<none>"} branch ${rowBranch ?? "<none>"} verdict ${outcome ?? "<none>"} scope ${scope ?? "<none: unknown, accepted>"} at ${at ?? "<unknown>"}`;

  if (rowBranch && rowBranch !== branch) {
    return { ok: false, reason: "wrong-branch", sha, outcome, at, branch: rowBranch, detail: `last sweep was on '${rowBranch}', not '${branch}' — ${stamp}` };
  }
  if (outcome !== "green" && outcome !== "red") {
    return { ok: false, reason: "not-an-answer", sha, outcome, at, branch: rowBranch, detail: `last sweep produced no verdict (${outcome}) — ${stamp}` };
  }
  if (outcome === "red") {
    return { ok: false, reason: "red", sha, outcome, at, branch: rowBranch, scope, detail: `last sweep was RED — ${stamp}`, message: row.message ?? null };
  }
  if (scope !== null && scope !== "full") {
    // #1231 — green, but the runner says it did not run everything. A scoped green is not the
    // full-suite signal this promotion is gated on; treating it as one is the defect this ticket
    // exists for. A null scope stays accepted (pre-#1231 rows, projects with no step contract).
    return { ok: false, reason: "scoped", sha, outcome, at, branch: rowBranch, scope, detail: `last green sweep ran scope=${scope}, not the full suite (a null scope would be accepted as pre-#1231) — ${stamp}` };
  }
  const ageMs = at ? nowMs - Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ageMs)) {
    return { ok: false, reason: "undated", sha, outcome, at, branch: rowBranch, scope, detail: `green sweep has no readable timestamp — ${stamp}` };
  }
  if (ageMs > maxAgeMs) {
    const hours = (ageMs / 3600_000).toFixed(1);
    return { ok: false, reason: "stale", sha, outcome, at, ageMs, branch: rowBranch, scope, detail: `last green sweep is ${hours}h old (limit ${(maxAgeMs / 3600_000).toFixed(1)}h) — ${stamp}` };
  }
  if (!sha) {
    return { ok: false, reason: "no-sha", outcome, at, branch: rowBranch, scope, detail: `green sweep row carries no sha — ${stamp}` };
  }
  return { ok: true, reason: "green", sha, outcome, at, ageMs, branch: rowBranch, scope, detail: `green sweep — ${stamp}` };
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
 * Does the reprobe response say a probe is running FOR THIS PROJECT?
 *
 * Only two fields say that: `started` (this request launched one) and
 * `skippedReason === "probe_in_flight"` (this project's persisted start stamp is still live —
 * `isBaseHealthProbeDue` reads it per project). `joinedRunningProbe` does NOT: it is
 * `inFlightBaseBranchProbeCount() > 0`, a board-wide count, so ANOTHER project's probe sets it.
 * Reading it as "ours is running" makes a promotion stop asking and wait out its whole budget for
 * a verdict that will never be recorded for this project — a refusal that sends the operator
 * straight back to `--force-sweep`, i.e. exactly the #1044 trap.
 */
export function isProbingThisProject(answer) {
  return answer?.started === true || answer?.skippedReason === "probe_in_flight";
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
 * @param {string|null} p.headSha   the branch tip, so a RED verdict about a commit that is no longer the tip
 *                                  can be re-probed rather than refused (#1060). Null keeps the old refusal.
 */
export function planSweepAcquisition({ verdict, direction = null, forceSweep = false, awaitSweep = true, canRequest = true, recover = false, headSha = null } = {}) {
  if (recover) {
    return { request: false, reason: "recover", detail: "--recover consults no sweep verdict — the build/migrate/restart/smoke pipeline and its rollback are this lane's gate" };
  }
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
    } else if (direction?.reason === "same" && headSha && verdict.sha && headSha !== verdict.sha) {
      // #1061 — the same family as #1044 and #1060, and the worst of the three because it does
      // not refuse: it SUCCEEDS at doing nothing. `sha` to promote is `verdict.sha`, so when the
      // verdict describes exactly what stable already runs, a promotion mints a second tag on
      // that identical sha, rebuilds, restarts the operating board, prints "is live", and leaves
      // every commit made since UNPROMOTED. `checkPromoteDirection` classifies this `ok: true`
      // ("same" = not blocking), which is what let it through — but "same" means the recorded
      // verdict cannot authorize ANY change, not that everything is fine.
      //
      // There IS work to deploy (the branch has moved), so this is the #1044 shape exactly: the
      // only thing missing is a CURRENT verdict. Ask for one.
      need = `the last green sweep (${verdict.sha}) is exactly what the stable checkout already runs, `
        + `while the branch has moved on to ${headSha} — promoting on this verdict would redeploy the `
        + `identical sha and silently leave the newer commits behind`;
    }
  } else if (REPROBEABLE_SWEEP_REASONS.includes(verdict?.reason)) {
    need = `no usable sweep verdict (${verdict.reason})`;
  } else if (verdict?.reason === "red") {
    // A red verdict refuses a re-probe — but only while it still DESCRIBES the tree (#1060).
    //
    // #1044's rule ("re-probing a broken master is not evidence-gathering") is right, and it was
    // being applied to the verdict alone, ignoring whether the verdict is still about HEAD. Once
    // the breakage is FIXED, the red row is about a commit that is no longer the tip, and it says
    // nothing whatever about the new one. Probing then is not "re-probing a red master" — it is
    // probing a DIFFERENT, unmeasured commit, which is ordinary evidence-gathering and exactly
    // what a stale-but-green verdict already gets a few lines above.
    //
    // That asymmetry was the defect, and it is not theoretical: on 2026-09-08 a promotion went
    // red, the breach was fixed on master minutes later, and the next run refused with "Fix
    // master" — which had just been done — offering only `--force-sweep`, the one path #1044
    // exists to stop being routine. It happened twice in one session.
    //
    // Unknown HEAD keeps today's refusal: a comparison that cannot be made is not a licence.
    if (headSha && verdict.sha && verdict.sha !== headSha) {
      need = `the RED verdict is on ${verdict.sha} but the branch tip is now ${headSha} — that verdict `
        + `describes a commit that is no longer the tip, so this is probing an unmeasured tree, not re-probing a broken one`;
    } else {
      return {
        request: false,
        reason: "red",
        detail: "the last sweep was RED and it is ON the current branch tip — master is broken; re-probing it is not "
          + "evidence-gathering. Fix master and re-run this (a red verdict about a commit that is no longer the tip is "
          + "re-probed automatically), or promote deliberately with --force-sweep.",
      };
    }
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
  recovery = null,
}) {
  const step1 = {
    n: 1,
    title: recovery
      ? "sweep NOT consulted (--recover) — the delta is reviewed, the pipeline is the gate"
      : forceSweep
        ? "sweep check SKIPPED (--force-sweep)"
        : "check the last full sweep on master was green",
    detail: recovery
      ? `${recovery}
      the gate is steps 5-9: a failed build, a board that will not boot, or a failed smoke roll back automatically`
      : forceSweep
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

// --- the restart-only door (#1202) ------------------------------------------------------------

/**
 * One refusal line for the restart-only door: `refused: <pid> already serves <port>
 * (<command-line excerpt>)`. Used whether or not the pid turns out to belong to the stable
 * checkout — this door never kills, so ownership only changes what gets logged, never the
 * outcome.
 */
export function formatRestartRefusal({ pid, port, commandLine, maxLen = 160 }) {
  const excerpt = commandLine
    ? commandLine.length > maxLen
      ? `${commandLine.slice(0, maxLen)}...`
      : commandLine
    : "<command line unavailable>";
  return `refused: ${pid} already serves ${port} (${excerpt})`;
}

/**
 * Restart-only decision (#1202) — the pure half of `pnpm stable:start` / `promote.mjs
 * --restart-stable`.
 *
 * The door has exactly two things it may do: leave an already-served port alone, or start a
 * fresh stable board on a free one. It never kills a listener, so unlike {@link
 * checkPromoteDirection}'s or `stopStableBoard`'s use of `planPortOwnerKill`, ownership does not
 * change the OUTCOME here — any pid already on the port is a refusal, whether it is the stable
 * board itself (already up, nothing to do) or something foreign (the board can't bind anyway).
 * It only changes what the refusal line says, via `commandLine`.
 *
 * @param {number} p.port    the stable port being checked
 * @param {{pid: string, commandLine?: string}[]} p.owners  every pid currently listening on it,
 *   as returned by the same listener lookup `stopStableBoard` uses — empty means free
 */
export function planRestartOnly({ port, owners = [] } = {}) {
  if (owners.length === 0) {
    return { ok: true, code: 0, detail: `nothing listens on ${port} — safe to start`, lines: [] };
  }
  const lines = owners.map(({ pid, commandLine }) => formatRestartRefusal({ pid, port, commandLine }));
  return { ok: false, code: 2, detail: lines.join("; "), lines };
}

// --- the recovery lane (#1054) ---------------------------------------------------------------

/**
 * Where a recovery promotion records that the stable board is running UNSWEPT code, relative
 * to the STABLE checkout. Read by the Sentinel; written only by a recovery run that got as far
 * as a passing smoke.
 */
export const RECOVERY_STATE_RELPATH = join(".kanban", "promote-recovery.json");

/**
 * The one path prefix whose changes a rollback CANNOT undo.
 *
 * `deployRef` runs `pnpm db:migrate` on whatever ref it deploys, and the rollback deploys the
 * PREVIOUS tag through the same function — so it restores code but re-runs a forward-only
 * migrator against a database the failed promotion has already migrated. Every other file in a
 * promotion is one `git reset --hard` away from being undone; a migration is not.
 */
export const MIGRATIONS_PATH_PREFIX = "packages/shared/drizzle/";

/**
 * Describe the delta a recovery promotion would deploy.
 *
 * Deliberately descriptive, not judgemental: on a single-user laptop the operator is the review,
 * so the job here is to make the delta legible (and to spot the one irreversible shape), not to
 * cap it. An earlier draft of this lane refused above N commits; that was dropped, because the
 * cost of a wrong refusal — the operator reaching for `--force-sweep` again — is higher than the
 * cost of deploying a big delta whose rollback works.
 *
 * @param {object} p
 * @param {string[]} p.commits       one-line subjects, newest first
 * @param {string[]} p.changedFiles  repo-relative paths in the delta
 */
export function classifyRecoveryDelta({ commits = [], changedFiles = [] } = {}) {
  const migrations = changedFiles.filter((f) => String(f).split("\\").join("/").startsWith(MIGRATIONS_PATH_PREFIX));
  return {
    commitCount: commits.length,
    commits,
    fileCount: changedFiles.length,
    migrations,
    hasMigration: migrations.length > 0,
  };
}

/**
 * May this recovery promotion proceed? (#1054)
 *
 * The lane's premise is that on a local, single-user board the existing pipeline — build →
 * migrate → restart → smoke → automatic rollback — IS the gate, and that pre-verification
 * bought at the cost of minutes is a bad trade at that blast radius. So this refuses on exactly
 * one thing: a migration in the delta, which is the only step the rollback cannot reverse.
 *
 * It is an ACK, not a prohibition. `--with-migration` proceeds, because an operator who is
 * refused on the day their fix happens to carry a schema change is an operator who goes back to
 * `--force-sweep` — and that is how a loud escape hatch stops being loud.
 *
 * @param {object} p
 * @param {ReturnType<typeof classifyRecoveryDelta>} p.delta
 * @param {boolean} p.withMigration  `--with-migration` was passed
 */
export function planRecoveryLane({ delta, withMigration = false } = {}) {
  if (!delta) return { ok: false, reason: "no-delta", detail: "the delta could not be computed — refusing rather than guessing" };
  if (delta.hasMigration && !withMigration) {
    return {
      ok: false,
      reason: "migration",
      detail:
        `the delta contains ${delta.migrations.length} migration file(s) (${delta.migrations.join(", ")}). ` +
        `A rollback restores code but NOT schema — 'pnpm db:migrate' is forward-only and the rollback re-runs it ` +
        `on the previous tag, so this is the one change a failed recovery cannot undo. ` +
        `Re-run with --with-migration once you have decided that is acceptable, or promote through the full sweep.`,
    };
  }
  return {
    ok: true,
    reason: delta.hasMigration ? "migration-acked" : "reversible",
    detail: delta.hasMigration
      ? `${delta.commitCount} commit(s), ${delta.fileCount} file(s), INCLUDING ${delta.migrations.length} migration(s) — acked with --with-migration`
      : `${delta.commitCount} commit(s), ${delta.fileCount} file(s), no migrations — a failed smoke rolls all of it back`,
  };
}

/**
 * The disclosure a recovery promotion leaves behind.
 *
 * This is the lane's only bookkeeping obligation, and it is a DISCLOSURE, not a repair: it says
 * the running board carries code no full sweep has ever judged. #1044 already fixed the
 * structural half — when the last green sweep ends up BEHIND what stable runs,
 * `planSweepAcquisition` requests a fresh one instead of refusing — so nothing here needs to
 * un-poison the direction check. What was missing is that no one could TELL.
 */
export function buildRecoveryRecord({ tag, sha, previousTag, delta, lane, atIso = new Date().toISOString() } = {}) {
  return {
    kind: "recovery-promotion",
    at: atIso,
    tag: tag ?? null,
    sha: sha ?? null,
    rollbackTag: previousTag ?? null,
    sweepOwed: true,
    sweptBy: null,
    lane: lane ?? null,
    delta: delta
      ? { commitCount: delta.commitCount, fileCount: delta.fileCount, migrations: delta.migrations }
      : null,
  };
}

/** One line for the promote log / dry run — what this lane is doing and what it is not. */
export function formatRecoveryLane(lane, delta) {
  if (!lane) return "not a recovery run";
  const head = lane.ok ? "RECOVERY" : "RECOVERY REFUSED";
  const commits = delta?.commits?.length ? ` [${delta.commits.slice(0, 5).join(" | ")}${delta.commits.length > 5 ? " | …" : ""}]` : "";
  return `${head} (${lane.reason}): ${lane.detail}${commits}`;
}

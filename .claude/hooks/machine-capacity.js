/**
 * Machine-capacity guard for expensive Stop hooks.
 *
 * A hook runs synchronously in the agent's critical path, so its cost is paid in
 * latency on EVERY turn. That is affordable when the box has room and actively
 * harmful when it does not: this machine is 16 cores / 28 GB shared between
 * several Claude sessions plus their subagents, and its kernel pool leak
 * routinely leaves under 1 GB genuinely free. Spawning a vitest or tsc fleet
 * into that state does not just run slowly — it pushes the box further into
 * swapping and slows down every OTHER session too, which is the opposite of what
 * a feedback hook is for.
 *
 * So an expensive check asks first, and when the answer is no it SKIPS LOUDLY
 * rather than either (a) running anyway and taking the machine down, or (b)
 * failing closed and reporting a machine condition as if it were a code defect.
 * A skip is honest: it says the check did not run and why. The pre-merge gate is
 * the real correctness gate and still runs the full suite — a skipped Stop hook
 * loses fast local feedback, never a merge guarantee.
 *
 * Why `os.freemem()` and not a load average: `os.loadavg()` returns [0,0,0] on
 * Windows (verified on this box), so it carries no signal at all here. freemem is
 * optimistic — measured side by side, it read 4.72 GB while the fleet tool
 * reported 2.5 GB usable, because it counts standby cache the OS can reclaim.
 * The default threshold is calibrated against that skew, not against the fleet
 * number: 2 GB of freemem corresponds to roughly "under a gigabyte truly free".
 *
 * This is a cheap heuristic on purpose — one in-process syscall, no spawn. A hook
 * that shelled out to a capacity tool would pay a process launch on every turn to
 * decide whether it can afford a process launch.
 */

const os = require("os");
const { spawnSync } = require("child_process");

const GB = 2 ** 30;
/** Default floor, in GB of os.freemem(). Override with SMART_HOOKS_MIN_FREE_GB. */
const DEFAULT_MIN_FREE_GB = 2;

/**
 * Should an expensive check stand down right now?
 *
 * Returns `{ hold, reason, freeGb }`. `hold` is true when the box is too tight to
 * add a build/test process. Set SMART_HOOKS_FORCE=1 to run regardless (the
 * pre-merge gate and any deliberate manual run should not be second-guessed by a
 * heuristic), or SMART_HOOKS_MIN_FREE_GB to retune the floor per machine.
 */
function capacityHold({ label = "check", minFreeGb } = {}) {
  if (process.env.SMART_HOOKS_FORCE === "1") {
    return { hold: false, reason: "SMART_HOOKS_FORCE=1", freeGb: null };
  }

  const floor = Number(
    minFreeGb ?? process.env.SMART_HOOKS_MIN_FREE_GB ?? DEFAULT_MIN_FREE_GB,
  );
  // A malformed override must not silently disable the guard OR silently block
  // every check — fall back to the default rather than trusting NaN.
  const effectiveFloor = Number.isFinite(floor) && floor >= 0 ? floor : DEFAULT_MIN_FREE_GB;

  let freeGb;
  try {
    freeGb = os.freemem() / GB;
  } catch {
    // Cannot read memory: run the check. Failing OPEN is right here — the guard
    // is an optimization, and a broken guard must not disable feedback.
    return { hold: false, reason: "freemem unreadable", freeGb: null };
  }

  if (freeGb >= effectiveFloor) {
    return { hold: false, reason: `${freeGb.toFixed(1)}GB free`, freeGb };
  }
  return {
    hold: true,
    freeGb,
    reason:
      `${label} SKIPPED — only ${freeGb.toFixed(1)}GB free (floor ${effectiveFloor}GB). ` +
      `Running it now would push this shared box further into swapping and slow every ` +
      `other session. This is a MACHINE condition, not a code failure: nothing was ` +
      `verified, and nothing is claimed to have passed. The pre-merge gate still runs ` +
      `the full suite. Re-run manually with SMART_HOOKS_FORCE=1 if you need it now.`,
  };
}

/**
 * Read a wall-clock budget in ms from an env var, falling back to a default.
 * A malformed or non-positive value falls back rather than meaning "unbounded".
 */
function budgetMs(envName, defaultMs) {
  const raw = process.env[envName];
  if (raw === undefined) return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

/**
 * Did a spawnSync call hit its `timeout` rather than finishing?
 *
 * Node reports this as `error.code === "ETIMEDOUT"`, but on Windows a killed
 * child can also surface as a bare signal with no error object, so check both.
 */
function hitBudget(result) {
  if (!result) return false;
  if (result.error && result.error.code === "ETIMEDOUT") return true;
  return result.error == null && result.status === null && result.signal != null;
}

/**
 * Kill a spawned process TREE on Windows, rooted at `pid`.
 *
 * Why not `taskkill /T`: it walks the tree through LIVE parents, and by the time
 * we get here Node's own spawnSync timeout has ALREADY killed our direct child.
 * That child is `cmd.exe` (shell:true is required to find pnpm on Windows), so
 * the tree is broken before the kill runs — /T finds nothing and the tsc/vitest
 * workers underneath survive, reparented. Verified: a budget-killed typecheck
 * left a live `tsc --noEmit` behind. Those processes do terminate on their own,
 * but a hook that fires on every turn would keep stacking them onto a box that
 * was already too loaded to run the check.
 *
 * WMI still reports each survivor's ORIGINAL ParentProcessId after the parent
 * dies, so walk the tree from that stale data and kill the members by id. Depth
 * is bounded, and only descendants of OUR pid are touched — never another
 * session's run. (A pid recycled into the tree within these milliseconds would
 * be a false positive; that window is small enough to accept, and the
 * alternative is leaking worker fleets.)
 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    return;
  }
  const script = [
    "$ids=@(" + pid + ")",
    "$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId",
    "for($i=0;$i -lt 6;$i++){",
    "  $next=@($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId })",
    "  if($next.Count -eq 0){ break }",
    "  $ids += $next",
    "}",
    "$ids | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop } catch {} }",
  ].join("\n");
  try {
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 15000,
    });
  } catch {
    /* best effort */
  }
}

/**
 * The message an over-budget check prints. Deliberately the same shape as a
 * capacity hold: it says plainly that nothing ran to completion and nothing is
 * claimed to pass, so it can never be mistaken for a green check.
 */
function budgetMessage(label, ms) {
  return (
    `${label} EXCEEDED its ${Math.round(ms / 1000)}s budget and was stopped. This check is a fast ` +
    `local smoke, not the correctness gate — a check that cannot finish in budget is pure ` +
    `latency plus a misleading veto, so it stands down instead. NOTHING was verified and ` +
    `nothing is claimed to have passed; the pre-merge gate still runs the full suite. Raise ` +
    `the budget for one run with SCOPED_VITEST_BUDGET_MS / SCOPED_TYPECHECK_BUDGET_MS, or `+
    `run the check by hand.`
  );
}

module.exports = { capacityHold, DEFAULT_MIN_FREE_GB, budgetMs, hitBudget, killTree, budgetMessage };

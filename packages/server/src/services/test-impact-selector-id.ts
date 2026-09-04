/**
 * The test-impact SELECTOR's identity, as a component of the merge-gate verification key (#958).
 *
 * WHY THIS EXISTS. The gate-PASS tree memo is keyed on `${projectId}:${verificationKey}:${treeHash}`,
 * and #678 already folded the TIER and the effective verify command into `verificationKey`.
 *
 * What `treeHash` does NOT cover is the SELECTOR, because the selector is not in the tree: the skill
 * is materialized into the worktree UNTRACKED (`.git/info/exclude`). Bump `impact.mjs`, or change a
 * score floor that is resolved from a preference rather than written literally into `verify_script`,
 * and the SELECTED SET changes while tree, tier and verify command are all identical. A pass banked
 * under a narrower old selector then replays under a wider new one — a stale green, which is the one
 * failure direction the gate may never take.
 *
 * WHY `selector-id` AND NOT `select --json`'s `selectorId` (the #678 trap). The memo key is read
 * BEFORE the gate resolves anything expensive, so its every component must be resolvable at that
 * point. `selector-id` reads no inventory, no git history and no working tree — it hashes the
 * script's own bytes, the resolved `.test-impact.json`, and the selection-affecting flags — so it
 * costs about a node startup (~0.3 s) and answers even in a repo where `build` has refused to
 * produce a map at all. Sourcing the component from `select --json` instead would reintroduce
 * exactly the ordering dependency this avoids: `select` needs an inventory, so a repo without one
 * would yield no key component on the very path that most needs a correct one.
 *
 * WHY THE WHOLE SCRIPT IS HASHED rather than a hand-kept `SELECTOR_VERSION` constant: a forgotten
 * constant bump fails toward a STALE GREEN, while a comment-only edit merely costs one extra gate
 * run. Deliberate, and the conservative direction.
 *
 * ABSENCE IS A STABLE EMPTY VALUE, never an error and never a random token. A project that does not
 * use the selector — which is every project today — must keep the keys it already has, so its banked
 * greens are not invalidated by this change landing. Every failure path (no worktree, no skill
 * materialized, a non-zero exit, a spawn error, a timeout, unparseable output) therefore resolves to
 * `""`, which `gateVerificationKey` folds in as the same byte it folded in before this existed.
 *
 * That "" is also why this cannot make the gate WEAKER by failing: a lost selector id can only make
 * two genuinely different selectors share a key — the same exposure that existed before #958 — and
 * never make two identical ones look different in a way that skips a run. Errs toward re-running.
 *
 * THE MAP IS PART OF THE SELECTOR NOW (#1018). `selector-id` deliberately reads no inventory —
 * that is what lets it answer before `build` has ever run — and while the map was COMMITTED the
 * gap did not matter, because a rebuilt map changed `mergedTreeHash` and invalidated the memo on
 * its own. #1018 made the map an untracked artifact copied into the worktree, so it left the tree
 * hash and nothing else was watching it: two runs on the same merged tree, with the same selector,
 * could select different suites because the map between them had been rebuilt. So the component is
 * the tool's id PLUS the worktree map's own `commit:` stamp (`ti1:abc… map=8a0f35d793`, or
 * `map=absent`). This RE-KEYS every project that uses the selector exactly once — the conservative
 * direction, costing one extra gate run each — and it is read from the first few KB of the map
 * rather than by parsing 1.4 MB of JSON on the merge path.
 */
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { IMPACT_TOOL_RELATIVE_PATH, type RunImpactCommand } from "./test-impact-outcome.service.js";
import { IMPACT_MAP_PATH as IMPACT_MAP_RELATIVE_PATH } from "./test-impact-map.service.js";

/**
 * The value used when the selector is absent or unusable. Empty rather than a sentinel word, so
 * `gateVerificationKey(strategy, cmd)` and `gateVerificationKey(strategy, cmd, "")` hash the same
 * bytes and no existing memo entry churns.
 */
export const NO_SELECTOR_ID = "";

/**
 * Wall-clock ceiling. `selector-id` is essentially node startup, so this is a guard against a hung
 * script rather than a real budget — but it must exist, because this runs on the merge path and a
 * hang here would hold a gate open before it had even decided whether to run.
 */
export const SELECTOR_ID_TIMEOUT_MS = 20_000;

/**
 * A plausible selector id: the tool's own `ti<version>:<hex>` shape.
 *
 * Validated rather than trusted, because this string goes straight into a cache key. A tool that
 * printed a warning banner, a progress line, or an empty string must degrade to "no selector"
 * instead of keying the memo on garbage that changes every run (which would silently disable the
 * memo) or on a fragment shared by two different selectors (which would silently reuse a pass).
 */
const SELECTOR_ID_RE = /^ti\d+:[0-9a-f]{8,}$/;

const defaultRunCommand: RunImpactCommand = ({ cwd, args, timeoutMs }) =>
  new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolvePromise({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

/**
 * Parse `selector-id` stdout into a key component. Exported so the "what counts as an id" rule is
 * a table test rather than something only a live gate run would exercise.
 *
 * Takes the LAST non-empty line: a tool is entitled to print a deprecation or config notice above
 * its answer, and the answer is what it ends with.
 */
export function parseSelectorId(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const candidate = lines[lines.length - 1] ?? "";
  return SELECTOR_ID_RE.test(candidate) ? candidate : NO_SELECTOR_ID;
}

/** How much of the map to read looking for its stamp. The header is the first ~200 bytes. */
const MAP_STAMP_READ_BYTES = 4096;

/**
 * The map's own `commit:` stamp, as a key component (#1018), or `"absent"`.
 *
 * Read from the HEAD of the file, never by `JSON.parse`: the map is ~1.4 MB of one-entry-per-line
 * JSON and this runs on the merge path, before the gate has decided whether to run anything at
 * all. The stamp is in the object's first ~200 bytes (`{"format":…,"commit":"8a0f35d793",…`).
 *
 * `"absent"` — a stable word, not an error and not an empty string — covers both "no map here"
 * and "a map whose header does not carry a stamp". Both mean the selection ran without a usable
 * inventory and widened, and two such runs SHOULD share a key.
 */
export function readImpactMapStamp(workingDir: string): string {
  const mapPath = join(workingDir, ...IMPACT_MAP_RELATIVE_PATH.split("/"));
  let fd: number | undefined;
  try {
    fd = openSync(mapPath, "r");
    const buf = Buffer.alloc(MAP_STAMP_READ_BYTES);
    const read = readSync(fd, buf, 0, MAP_STAMP_READ_BYTES, 0);
    const match = /"commit"\s*:\s*"([^"]+)"/.exec(buf.subarray(0, read).toString("utf8"));
    return match?.[1] ?? "absent";
  } catch {
    return "absent";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch { /* a closed-twice fd is not worth failing a gate over */ }
    }
  }
}

export interface ResolveSelectorIdInput {
  /** The worktree the gate will run in — where the skill is materialized. */
  workingDir: string | null | undefined;
  /**
   * Selection-affecting flags the gate would pass to `select`, so the id covers them too. The
   * selector hashes these itself; passing them here is what makes a project that pins
   * `--min-score` key differently from one that does not.
   */
  selectorArgs?: readonly string[];
  /** Injected for tests. */
  runCommand?: RunImpactCommand;
  log?: (message: string) => void;
}

/**
 * Resolve the selector identity for a worktree, or {@link NO_SELECTOR_ID}. Never throws.
 */
export async function resolveSelectorId(input: ResolveSelectorIdInput): Promise<string> {
  const log = input.log ?? ((message: string) => console.warn(`[test-impact] ${message}`));
  const run = input.runCommand ?? defaultRunCommand;
  try {
    const { workingDir } = input;
    if (!workingDir) return NO_SELECTOR_ID;
    const toolPath = join(workingDir, IMPACT_TOOL_RELATIVE_PATH);
    // The overwhelmingly common case for a project that does not use this skill. Silent by
    // design — see `recordGateOutcome`, which makes the same distinction for the same reason.
    if (!existsSync(toolPath)) return NO_SELECTOR_ID;

    const result = await run({
      cwd: workingDir,
      args: [toolPath, "selector-id", ...(input.selectorArgs ?? [])],
      timeoutMs: SELECTOR_ID_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      log(
        `selector-id exited ${result.exitCode} in ${workingDir} — the gate memo key will not carry a selector component ` +
          `(safe: it can only cost an extra gate run): ${(result.stderr || result.stdout).trim().split("\n").slice(-1)[0] ?? ""}`,
      );
      return NO_SELECTOR_ID;
    }
    const selectorId = parseSelectorId(result.stdout);
    if (!selectorId) {
      log(`selector-id printed no recognizable id in ${workingDir} — the gate memo key will not carry a selector component`);
      return NO_SELECTOR_ID;
    }
    // #1018 — the map is no longer in the tree hash, so the memo would otherwise be blind to a
    // rebuild between two runs on the same merged tree. Appended rather than folded into the
    // tool's own hash so the component stays readable in a log line.
    return `${selectorId} map=${readImpactMapStamp(workingDir)}`;
  } catch (err) {
    // A key component that cannot be resolved must never break the merge path.
    log(`selector-id failed unexpectedly: ${errorMessage(err)}`);
    return NO_SELECTOR_ID;
  }
}

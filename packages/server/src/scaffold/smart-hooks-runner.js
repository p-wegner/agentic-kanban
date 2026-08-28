#!/usr/bin/env node
// @board-hook-version: 1
/**
 * Smart Hooks Runner — config-driven hook runner for agentic-kanban.
 *
 * Adapted from the beyond-vibe-coding pattern. Reads checks from
 * smart-hooks-config.json instead of hardcoding per-hook logic.
 *
 * Usage:
 *   node smart-hooks-runner.js PostToolUse   (called after Write/Edit/MultiEdit)
 *   node smart-hooks-runner.js Stop          (called when agent stops)
 *
 * State file: .claude/hooks/.smart-hooks-state.json
 *   - Tracks edited files across PostToolUse calls
 *   - Cleared after Stop hooks run
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");
const { cachedTopology } = require("./git-topology-cache.js");

// #913 — the posture policy and the capacity heuristic. Loaded DEFENSIVELY, unlike
// git-topology-cache.js above: this runner is also the scaffold source shipped into
// every driven project, and a project scaffolded before these two files existed must
// keep working rather than dying at load time with MODULE_NOT_FOUND on every tool
// call. Absent -> the pre-#913 behaviour (run everything, gate nothing), which is the
// safe direction: it can only make the chain do MORE work, never less.
function optionalHookModule(specifier) {
  try {
    return require(specifier);
  } catch {
    return null;
  }
}
const capacityModule = optionalHookModule("./machine-capacity.js");
const postureModule = optionalHookModule("./hook-posture.js");

let hookInput = {};

// Set by the container wrap (containerEnv in devcontainer-workspace.service.ts) on every
// containerized builder launch — the ONLY reliable signal this process has that it's running
// inside a builder image rather than on the host. Host-shaped checks (stack quick-checks
// generated from the HOST toolchain profile) assume host binaries/paths that may not exist
// in the image, so they degrade to a skip-with-visible-log instead of exec'ing and failing
// closed on every Stop (#158).
function isContainerized() {
  return process.env.AGENTIC_KANBAN_CONTAINER === "1";
}

// See validate-command-safety.js: these are constant per start directory but were
// re-spawning `git` on every call. Cache on startDir rather than unconditionally,
// since hookInput.cwd is filled in asynchronously from stdin.
const gitLookupCache = new Map();

function cachedGitLookup(kind, startDir, resolve) {
  const cacheKey = `${kind} ${startDir}`;
  if (gitLookupCache.has(cacheKey)) return gitLookupCache.get(cacheKey);
  // Constant per start directory, but each hook call is a fresh process, so this
  // re-spawned git every time — 1.9s/4.0s for toplevel/common-dir while the board's
  // reconcilers are running. Persist across invocations (#279).
  const value = cachedTopology(kind, startDir, resolve);
  gitLookupCache.set(cacheKey, value);
  return value;
}

function getProjectDir() {
  const startDir = process.env.CLAUDE_PROJECT_DIR || hookInput.cwd || process.cwd();
  return cachedGitLookup("toplevel", startDir, () => {
    try {
      return execSync("git rev-parse --show-toplevel", {
        cwd: startDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();
    } catch {
      return startDir;
    }
  });
}

function getScriptProjectDir() {
  return path.resolve(__dirname, "..", "..");
}

function getConfigPath(projectDir = getProjectDir()) {
  return path.join(projectDir, ".claude", "hooks", "smart-hooks-config.json");
}

function getRulesPath(projectDir = getProjectDir()) {
  return path.join(projectDir, ".claude", "smart-hooks-rules.json");
}

function getStatePath() {
  return path.join(getProjectDir(), ".claude", "hooks", ".smart-hooks-state.json");
}

/**
 * Load the generated per-project edit-time feedback rules (#787) and convert each into a
 * runner "check". The rules file is machine-generated from the stack profile and uses a flat
 * `{ rules: [...] }` shape; the runner's check shape needs an `enabled` flag (rules are always
 * active).
 *
 * A rule may name the events it runs on via `events: ["PostToolUse"|"Stop"]`. Absent (every
 * rule generated before this field existed), it runs on BOTH — the original behavior, kept so
 * an older rules file kept working unchanged. The field exists because a rule whose command is
 * not scoped to the edited file (a test suite) costs its FULL runtime on every single edit
 * while telling you nothing an end-of-turn run wouldn't; measured on this repo, per-edit
 * typecheck+tests ran to their timeouts for a median of 5m50s per Write/Edit and produced no
 * signal at all, because both were killed before finishing.
 */
const GENERATED_RULE_EVENTS = ["PostToolUse", "Stop"];

/**
 * Which events a generated rule runs on. Unset/unusable -> both, i.e. the pre-`events`
 * behavior: a malformed value must not silently disable a check that used to run.
 */
function normalizeRuleEvents(events) {
  if (!Array.isArray(events)) return [...GENERATED_RULE_EVENTS];
  const valid = events.filter((e) => GENERATED_RULE_EVENTS.includes(e));
  return valid.length > 0 ? valid : [...GENERATED_RULE_EVENTS];
}

function loadGeneratedRules(projectDir) {
  let rules;
  try {
    rules = JSON.parse(fs.readFileSync(getRulesPath(projectDir), "utf8")).rules;
  } catch {
    return [];
  }
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r) => r && r.command)
    .map((r) => ({
      enabled: true,
      name: r.name || "Check",
      command: r.command,
      filePatterns: Array.isArray(r.filePatterns) ? r.filePatterns : [],
      blocking: r.blocking !== false,
      timeout: typeof r.timeout === "number" ? r.timeout : 120,
      events: normalizeRuleEvents(r.events),
      // Generated rules are always derived from the HOST stack profile (host pnpm/tsc/etc
      // paths) — never safe to trust verbatim inside a builder container (#158).
      containerSkippable: true,
      // #913 — marks this as a GENERATED stack rule so the posture policy and the capacity
      // gate can see it. It was invisible to both: `runCheck` went straight to execSync, so a
      // generated rule spawned a full build on a box the hand-authored checks had already
      // declined to load.
      generated: true,
    }));
}

function loadConfig(projectDir = getProjectDir()) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(getConfigPath(projectDir), "utf8"));
  } catch {
    config = { hooks: {} };
  }
  if (!config.hooks) config.hooks = {};

  // Merge the generated stack-profile rules into the PostToolUse + Stop checks so a driven
  // project gets incremental edit-time feedback without any hand-authored config (#787).
  const generated = loadGeneratedRules(projectDir);
  if (generated.length > 0) {
    const forEvent = (ev) => generated.filter((r) => r.events.includes(ev));
    config.hooks.PostToolUse = [...(config.hooks.PostToolUse || []), ...forEvent("PostToolUse")];
    config.hooks.Stop = [...(config.hooks.Stop || []), ...forEvent("Stop")];
  }
  return config;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(), "utf8"));
  } catch {
    return { editedFiles: [] };
  }
}

function saveState(state) {
  const p = getStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function clearState() {
  const p = getStatePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function toRelative(filePath) {
  const projectDir = getProjectDir();
  if (path.isAbsolute(filePath) && filePath.startsWith(projectDir)) {
    return path.relative(projectDir, filePath).replace(/\\/g, "/");
  }
  return filePath.replace(/\\/g, "/");
}

function matchesPatterns(filePath, patterns) {
  if (!patterns || patterns.length === 0) return true;
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.some((p) => {
    const re = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "{{GLOBSTAR}}")
      .replace(/\*/g, "[^/]*")
      .replace(/{{GLOBSTAR}}/g, ".*");
    return new RegExp(`^${re}$`).test(normalized);
  });
}

// Local hooks that expose an in-process entry point, keyed by the script basename
// their configured `command` ends with. Calling these via require() instead of
// execSync saves a full node cold start per invocation — on Windows under RAM
// pressure that is 0.5–1.2s EVERY shell tool call, and it was the direct cause of
// the spurious "timed out after 30s … Blocking anyway" fail-closed blocks on
// read-only commands (#279). The spawn path below is still the fallback for any
// hook without an in-process API, and the scripts remain standalone-runnable for
// Codex/Pi.
const IN_PROCESS_HOOKS = {
  "validate-command-safety.js": {
    module: "./validate-command-safety.js",
    run: (mod, inputData) => mod.evaluateCommand(inputData || {}),
  },
  // #914 — the other two shell guards. `.claude/settings.json` wired all three as SEPARATE
  // `Bash|PowerShell` PreToolUse entries, so every shell tool call paid three node cold
  // starts (0.5–1.2s each on Windows under RAM pressure) to answer three questions that
  // share a parsed command. Routed through the runner they cost one process total, and
  // `runCheck`'s existing catch keeps the fail-closed semantics: a guard that THROWS falls
  // through to the spawn path rather than being read as an allow.
  "vital-file-guard.js": {
    module: "./vital-file-guard.js",
    run: (mod, inputData) => mod.evaluateCommand(inputData || {}),
  },
  "prevent-cross-worktree-writes.js": {
    module: "./prevent-cross-worktree-writes.js",
    run: (mod, inputData) => mod.evaluateToolCall(inputData || {}),
  },
};

function inProcessHookFor(command) {
  if (typeof command !== "string") return null;
  for (const [basename, entry] of Object.entries(IN_PROCESS_HOOKS)) {
    // `node <any path>/<basename>` and nothing else — so a command that merely
    // passes the script to something else (or appends extra args we'd drop) still
    // takes the spawn path.
    const re = new RegExp(
      `^\\s*node\\s+(["']?)[^"']*${basename.replace(/[.]/g, "\\.")}\\1\\s*$`,
    );
    if (re.test(command)) return entry;
  }
  return null;
}

/**
 * The worktree's resolved posture, computed once per process (#913). A hook process
 * handles one event, so re-reading the ticket-context file per check would be pure
 * IO for an answer that cannot change.
 */
let _posture = null;
function posture() {
  if (_posture === null) {
    _posture = postureModule
      ? postureModule.resolvePosture(getProjectDir())
      : { posture: "standard", source: "hook-posture.js absent" };
  }
  return _posture;
}

/**
 * The two POLICY gates every spawning check passes through (#913), in order:
 *
 *   1. Posture — is this KIND of check run at all under the project's risk posture?
 *   2. Capacity — can this box afford the spawn right now?
 *
 * Returns null to proceed, or an inconclusive `runCheck`-shaped result. Both refusals
 * are `advisory` (never `blocking`) and both say plainly that nothing was verified: a
 * skipped check must never be mistakable for a green one, and neither a posture
 * setting nor a memory reading is evidence about the code. Same reasoning #487
 * applied to a timed-out check.
 *
 * A SAFETY check (`alwaysRun`) never reaches either gate — `checkAllowedUnderPosture`
 * classifies it as such and `capacityGate` returns early for it. A guard that stands
 * down because the box is busy is not a guard.
 */
function policyGate(check) {
  const { posture: level, source } = posture();
  if (postureModule) {
    const verdict = postureModule.checkAllowedUnderPosture(check, level);
    if (!verdict.run) {
      return {
        success: true,
        advisory: true,
        postureSkipped: true,
        output: `${verdict.reason} (posture source: ${source})`,
      };
    }
  }
  if (check.alwaysRun === true) return null;
  if (!capacityModule) return null;
  if (postureModule && !postureModule.policyFor(level).capacityGated) return null;

  const gate = capacityModule.capacityHold({ label: check.name || check.command });
  if (gate.hold) {
    return {
      success: true,
      advisory: true,
      capacityHeld: true,
      output:
        `${gate.reason}\n` +
        `The pre-merge train gate is what will run this check — it runs the full verify script ` +
        `with SMART_HOOKS_FORCE semantics, so nothing is lost, only deferred.`,
    };
  }
  return null;
}

function runCheck(check, inputData, editedFiles) {
  const timeout = (check.timeout || 30) * 1000;
  const env = {
    ...process.env,
    ...(editedFiles ? { SMART_HOOKS_EDITED_FILES: JSON.stringify(editedFiles) } : {}),
  };

  const inProcess = inProcessHookFor(check.command);
  if (inProcess) {
    try {
      const mod = require(inProcess.module);
      const verdict = inProcess.run(mod, inputData);
      const stderr = Array.isArray(verdict?.stderr) ? verdict.stderr.join("\n") : "";
      if (verdict?.decision === "block") {
        return { success: false, output: verdict.reason || stderr };
      }
      if (stderr) console.error(stderr);
      return { success: true, output: "" };
    } catch (err) {
      // A broken in-process hook must not silently allow: fall through to the
      // spawn path so the guard still gets its say.
      console.error(
        `[smart-hooks] in-process ${check.name || check.command} failed (${err && err.message}); ` +
        `falling back to spawning it.`
      );
    }
  }

  // EVERY spawn passes the policy gates — generated stack rules included (#913). This
  // sits below the in-process branch on purpose: an in-process hook costs no process
  // and no build, so gating it would buy nothing and could only weaken a guard.
  const gated = policyGate(check);
  if (gated) return gated;

  try {
    execSync(check.command, {
      cwd: check.cwd || getProjectDir(),
      timeout,
      encoding: "utf8",
      input: inputData ? JSON.stringify(inputData) : "",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    return { success: true, output: "" };
  } catch (err) {
    // A killed-on-timeout check still fails closed, but it is NOT a policy
    // decision — it never got to evaluate the command. Saying so turns an
    // empty-reason block (which reads as an unexplained veto) into an
    // actionable infra failure.
    const timedOut = err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    const output = [err.stdout || "", err.stderr || ""].join("\n").trim();
    if (timedOut) {
      // #487 — a timeout is INCONCLUSIVE, not evidence the code is broken: the check never
      // got to evaluate the command. For a SAFETY check (`alwaysRun`, e.g.
      // validate-command-safety) that ambiguity must still block — refusing to run beats
      // running something unvetted. For a speculative correctness check (typecheck, tests) it
      // must NOT: a command that cannot finish inside its budget then blocks unconditionally,
      // which makes the gate permanently red and therefore signal-free, and floods every
      // response with its own truncated output. Measured case: a generated rule ran the whole
      // `test:mine` suite (10+ min here) under a 180s timeout, so it could only ever time out.
      //
      // Same reasoning the merge gate already applies to a timed-out verify_script (#192:
      // "inconclusive/retryable, NOT proof the code is broken"). A REAL failure — the command
      // ran and exited non-zero — still blocks exactly as before.
      const isSafetyCheck = check.alwaysRun === true;
      return {
        success: !isSafetyCheck,
        timedOut: true,
        advisory: !isSafetyCheck,
        output:
          `${check.name || check.command} could not evaluate this command: ` +
          `the check timed out after ${timeout / 1000}s and was killed. ` +
          (isSafetyCheck
            ? `Blocking anyway (fail closed) — an unevaluated SAFETY check must not pass.`
            : `NOT blocking — a timeout is inconclusive, not a failure. If this check ` +
              `routinely times out, narrow its command (file-scoped instead of whole-suite) ` +
              `or raise its timeout; a check that can never finish carries no signal.`) +
          (output ? `\n${output}` : ""),
      };
    }
    return { success: false, output };
  }
}

// ---------------------------------------------------------------------------
// #759 — the compile check had no IN-FLIGHT awareness, so it demanded you fix a live agent's
// half-written file.
//
// #724 taught the uncommitted-files check to tell IN-FLIGHT subagent work from STRANDED work.
// The typecheck check in the same hook chain learned nothing, so it reproduced the failure #724
// fixed. Observed twice in one session, with the transition captured:
//
//   src/services/agent-remote.service.ts(762,3): error TS2739: ... is missing the following
//     properties from type 'RemoteAgentService': remoteSessionInfo, requestRepoOp
//   -> "Fix the issues before stopping."
//
// `remoteSessionInfo`/`requestRepoOp` were the two protocol operations a LIVE agent was mid-way
// through adding. No commit landed on that file; the next run of the same check passed, because
// the agent simply finished writing it. The break existed in no committed state — and the
// instruction was to edit a file another agent holds, which is the corruption the shared-index
// rule exists to prevent. It also trains the reader to disbelieve the one check that catches a
// real break per edit.
//
// So: classify before demanding. Reuses #724/#771's detection from check-uncommitted.js rather
// than re-deriving it — one notion of "who is holding this file", or the two drift.
//   - every error file is dirty AND held by a live agent (IN FLIGHT), or dirty-and-unattributable
//     while agents are live (UNKNOWN, #771's fail-safe bucket) -> advisory, does NOT block.
//   - anything else — a clean/committed file, or one attributed to THIS session — still blocks.
//     That is the real signal and must not be weakened.
//   - unparseable output, no transcript, detection unavailable -> block, as before (fail closed).
// The message always names which case it took, so "your break" is never confused with "someone
// else's edit in progress".
// ---------------------------------------------------------------------------

/** `src/x.ts(12,3): error TS2552: …` — tsc's own format, wherever it sits in a pnpm-prefixed line. */
const TS_ERROR_LINE = /([\w@./\\-]+\.(?:ts|tsx|mts|cts))\((\d+),(\d+)\):\s*error\s+TS\d+/g;

function parseCompileErrorFiles(output) {
  const files = new Set();
  const text = String(output || "");
  TS_ERROR_LINE.lastIndex = 0;
  let m;
  while ((m = TS_ERROR_LINE.exec(text)) !== null) {
    files.add(m[1].replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return [...files];
}

/**
 * Does `errorFile` (as tsc printed it, usually package-relative) name `dirtyPath` (repo-relative)?
 * Matching by tail is deliberate: tsc runs per package, so the two share only a suffix. A tail
 * match can over-match across packages with the same relative layout, which errs toward "someone
 * may be holding this" — the recoverable direction (#771).
 */
function compileErrorNamesPath(errorFile, dirtyPath) {
  const e = errorFile.toLowerCase();
  const d = dirtyPath.toLowerCase();
  return d === e || d.endsWith("/" + e) || e.endsWith("/" + d);
}

/**
 * Verdict for a failing compile check: `{ block, summary }`.
 *
 * `deps` is injectable so the classification is unit-testable without a live session
 * (`loadHook` -> the check-uncommitted exports, `projectDir`, `transcriptPath`).
 */
function classifyCompileFailure(output, deps) {
  const errorFiles = parseCompileErrorFiles(output);
  if (errorFiles.length === 0) {
    return { block: true, summary: "[typecheck] case: UNCLASSIFIED — no `file(line,col): error TSxxxx` lines to attribute; blocking (fail closed)." };
  }
  let hook;
  try {
    hook = deps.loadHook();
  } catch {
    hook = null;
  }
  if (!hook || typeof hook.trackedSourceChanges !== "function") {
    return { block: true, summary: "[typecheck] case: NO IN-FLIGHT DATA — in-flight detection unavailable; blocking (fail closed)." };
  }
  const projectDir = deps.projectDir;
  let activity = null;
  let dirty = { all: [] };
  try {
    activity = deps.transcriptPath ? hook.readSessionActivity(deps.transcriptPath) : null;
    dirty = hook.trackedSourceChanges(projectDir);
  } catch {
    return { block: true, summary: "[typecheck] case: NO IN-FLIGHT DATA — could not read git/transcript state; blocking (fail closed)." };
  }
  const live = activity && activity.liveSubagents ? activity.liveSubagents : 0;
  if (!live) {
    return {
      block: true,
      summary:
        "[typecheck] case: YOURS — no live subagent is holding anything, so this break is this " +
        "session's (or the committed state's). Blocking.",
    };
  }
  const part = hook.partitionAuthored(dirty.all, activity, projectDir);
  const heldByOthers = new Set([...(part.inFlight || []), ...(part.unknown || [])]);
  const held = [];
  const yours = [];
  for (const f of errorFiles) {
    const match = [...heldByOthers].find((p) => compileErrorNamesPath(f, p));
    if (match) held.push(`${f} (held: ${match})`);
    else yours.push(f);
  }
  if (yours.length === 0) {
    return {
      block: false,
      summary:
        `[typecheck] case: IN FLIGHT — all ${held.length} file(s) with errors are uncommitted and ` +
        `held by ${live} live subagent(s), so the break exists only in a half-written working tree. ` +
        "NOT blocking, and do NOT edit them:\n  ~ " + held.join("\n  ~ "),
    };
  }
  return {
    block: true,
    summary:
      `[typecheck] case: YOURS (mixed) — ${yours.length} file(s) with errors are NOT held by any of ` +
      `the ${live} live subagent(s), so they are this session's or the committed state's break:\n  - ` +
      yours.join("\n  - ") +
      (held.length > 0
        ? `\nThe other ${held.length} are in flight; leave them alone:\n  ~ ` + held.join("\n  ~ ")
        : ""),
  };
}

/**
 * Wrap a failing check's result in the #759 classification when its output looks like compile
 * errors. Opt-out (`inFlightAware: false`) rather than opt-in: the demand "fix this file" is only
 * actionable for a file nobody live is holding, whichever check produced it — and the check that
 * fired in the field is a GENERATED rule (`.claude/smart-hooks-rules.json`), not the hand-authored
 * config entry, so an opt-in flag would have missed the observed case entirely.
 */
function applyInFlightAwareness(check, result, input) {
  if (result.success || check.inFlightAware === false) return result;
  if (parseCompileErrorFiles(result.output).length === 0) return result;
  const verdict = classifyCompileFailure(result.output, {
    loadHook: () => require("./check-uncommitted.js"),
    projectDir: getProjectDir(),
    transcriptPath: input && (input.transcript_path || input.transcriptPath),
  });
  console.error(verdict.summary);
  if (verdict.block) {
    return { ...result, output: `${verdict.summary}\n\n${result.output}` };
  }
  // Not `advisory` — that flag means "inconclusive/timed out". This is a CONCLUSION: the break
  // is real and belongs to someone who is still writing it.
  return { ...result, success: true, inFlightExcused: true, output: "" };
}

// --- PreToolUse: prevent destructive operations before execution ---

function isShellTool(toolName) {
  return ["Bash", "PowerShell", "shell", "shell_command", "exec_command", "command_execution"].includes(toolName);
}

function extractCommand(input) {
  return (
    input.tool_input?.command ||
    input.tool_input?.Command ||
    input.command ||
    input.Command ||
    ""
  );
}

// Windows paths are case-insensitive with either separator; POSIX paths are
// case-sensitive with "/" only — lowercasing there would falsely match
// /home/Alice and /home/alice.
const IS_WINDOWS = process.platform === "win32";

function normalizePathForCompare(p) {
  const s = String(p || "");
  return IS_WINDOWS
    ? s.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
    : s.replace(/\/+$/, "");
}

function pathIsInside(child, parent) {
  const c = normalizePathForCompare(child);
  const p = normalizePathForCompare(parent);
  const sep = IS_WINDOWS ? "\\" : "/";
  return c === p || c.startsWith(`${p}${sep}`);
}

function getMainCheckout() {
  if (process.env.KANBAN_MAIN_CHECKOUT) return process.env.KANBAN_MAIN_CHECKOUT;
  // Derive the main checkout from git instead of hardcoding a machine-specific path.
  // In a worktree, --git-common-dir resolves to the MAIN checkout's .git, whose parent
  // is the main checkout; in the main checkout it resolves to ./.git → the repo root.
  const startDir = process.env.CLAUDE_PROJECT_DIR || hookInput.cwd || process.cwd();
  return cachedGitLookup("common-dir", startDir, () => {
    try {
      const commonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
        cwd: startDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();
      if (commonDir) return path.dirname(commonDir);
    } catch {}
    return getProjectDir();
  });
}

function isWorktreePath(p) {
  // `/` needs no escape inside a character class; escaping it is what `no-useless-escape`
  // flagged. Both separators still match — verified against a Windows and a POSIX path.
  return /[/\\]\.worktrees[/\\]/i.test(String(p || "")) || /--\.worktrees--/i.test(String(p || ""));
}

function commandRunsVitest(command) {
  return (
    /\bvitest\b/i.test(command) ||
    /\btest:mine\b/i.test(command) ||
    /\bpnpm(?:\.cmd)?\b[^\n]*(?:\btest\b|\bexec\s+vitest\b)/i.test(command)
  );
}

function commandMovesToMainCheckout(command) {
  const main = getMainCheckout();
  if (!main) return false;
  const m = command.match(/\b(?:cd|Set-Location|Push-Location)\s+["']?([^\s"';]+)/i);
  return m ? pathIsInside(m[1], main) : false;
}

function getToolCwd(input) {
  return (
    input.tool_input?.cwd ||
    input.tool_input?.workdir ||
    input.tool_input?.working_dir ||
    input.cwd ||
    ""
  );
}

function getSessionProjectHint(input) {
  return (
    input.transcript_path ||
    input.transcriptPath ||
    input.cwd ||
    process.env.CLAUDE_PROJECT_DIR ||
    ""
  );
}

function wrongCheckoutVitestReason(input, command) {
  if (!commandRunsVitest(command)) return null;
  const sessionProject = getSessionProjectHint(input);
  if (!isWorktreePath(sessionProject)) return null;

  const mainCheckout = getMainCheckout();
  const cwd = getToolCwd(input);
  const cwdIsMain = cwd && pathIsInside(cwd, mainCheckout);
  if (!cwdIsMain && !commandMovesToMainCheckout(command)) return null;

  return [
    "Run worktree tests from the worktree root, not the main checkout.",
    "",
    `This session is for a worktree (${sessionProject}), but the test command is running under:`,
    `  ${cwdIsMain ? cwd : mainCheckout}`,
    "",
    "Use:",
    "  cd <your worktree root>",
    "  pnpm test:mine -- --changed HEAD",
    "",
    "Or from a package directory in that same worktree:",
    "  pnpm exec vitest related <file>",
    "",
    "Do not run pnpm install to fix vitest import errors; report the environment issue and continue.",
  ].join("\n");
}

function handlePreToolUse(input) {
  const toolName = input.tool_name;

  // Only validate shell commands. Codex reports canonical shell hooks as Bash,
  // but older/local harnesses may use their implementation-specific names.
  if (!isShellTool(toolName)) {
    process.exit(0);
  }

  const command = extractCommand(input);
  const wrongCheckoutReason = wrongCheckoutVitestReason(input, command);
  if (wrongCheckoutReason) {
    console.error("[smart-hooks] Wrong-checkout Vitest guard: PREVENTED");
    console.error(wrongCheckoutReason);
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: wrongCheckoutReason,
      }) + "\n"
    );
    process.exit(2);
  }

  const policyDir = getScriptProjectDir();
  const config = loadConfig(policyDir);
  const checks = config.hooks?.PreToolUse || [];

  for (const check of checks) {
    if (!check.enabled) continue;

    // The WHOLE hook input, not just `{ command, cwd }` (#914): the cross-worktree guard
    // routes on `tool_name`/`tool_input` and would classify every call as "not a tool I
    // guard" — a silently disabled guard, which is the exact #391 failure shape. `command`
    // is added on top so the guards that read it flat (validate-command-safety,
    // vital-file-guard) see the normalized value the runner already extracted.
    const result = runCheck(
      { ...check, cwd: check.cwd || policyDir },
      { ...input, command, cwd: input.cwd },
      [],
    );

    if (!result.success) {
      console.error(`[smart-hooks] ${check.name}: PREVENTED`);
      if (result.output) console.error(result.output);
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: `${check.name}:\n\n${result.output}`,
        }) + "\n"
      );
      process.exit(2);
    }
  }
}

// --- PostToolUse: track edited files + run per-file checks ---

function handlePostToolUse(input) {
  const filePath = input.tool_input?.file_path || input.tool_input?.filePath || null;
  if (!filePath) return;

  const rel = toRelative(filePath);
  const state = loadState();
  if (!state.editedFiles.includes(rel)) {
    state.editedFiles.push(rel);
    saveState(state);
  }

  const config = loadConfig();
  const checks = config.hooks?.PostToolUse || [];

  for (const check of checks) {
    if (!check.enabled) continue;
    if (!matchesPatterns(rel, check.filePatterns)) continue;
    if (check.containerSkippable && isContainerized()) {
      console.error(
        `[smart-hooks] Skipping host-toolchain check "${check.name}" — containerized builder (#158).`
      );
      continue;
    }

    const command = check.command.replace(/\{file\}/g, rel);
    // #759 — a compile break in a file a live subagent is mid-way through writing is not this
    // session's to fix. Observed on this path too, not just on Stop.
    const result = applyInFlightAwareness(
      check,
      runCheck({ ...check, command }, input, state.editedFiles),
      input
    );

    if (result.advisory) {
      // #487 — inconclusive (timed out), deliberately not blocking. Say so on stderr so the
      // timeout is visible rather than silently swallowed.
      console.error(`[smart-hooks] ${check.name}: SKIPPED (inconclusive)`);
      if (result.output) console.error(result.output);
    }
    if (!result.success) {
      console.error(`[smart-hooks] ${check.name}: FAILED`);
      if (result.output) console.error(result.output);
      if (check.blocking) {
        process.stdout.write(
          JSON.stringify({
            decision: "block",
            reason: `${check.name} failed:\n\n${result.output}\n\nFix the issue before continuing.`,
          }) + "\n"
        );
        process.exit(2);
      }
    }
  }
}

// --- Stop: run full checks (tests, tsc, reminders) ---

function handleStop(input) {
  const state = loadState();
  const config = loadConfig();
  const checks = config.hooks?.Stop || [];
  if (checks.length === 0) {
    clearState();
    process.exit(0);
  }

  const blockReasons = [];
  const skippedContainerChecks = [];
  const isFirstStop = input.stop_hook_active !== true;
  // On re-prompt (stop_hook_active=true), only run checks marked alwaysRun.
  // File-dependent hooks (tests, tsc, playwright) are skipped on re-prompt.

  for (const check of checks) {
    if (!check.enabled) continue;

    // File-dependent checks: skip if no files were edited, or on re-prompt
    if (check.filePatterns && check.filePatterns.length > 0) {
      if (!isFirstStop) continue;
      if (state.editedFiles.length === 0) continue;
      if (!state.editedFiles.some((f) => matchesPatterns(f, check.filePatterns))) continue;
    } else if (!check.alwaysRun && !isFirstStop) {
      // Checks without filePatterns that aren't marked alwaysRun: skip on re-prompt
      continue;
    }

    // Host-shaped check (host toolchain paths/binaries) run inside a builder container:
    // skip with a visible, logged downgrade rather than exec'ing and failing closed on a
    // host assumption the image doesn't meet (#158) — this is what caused a stop-hook-error
    // on every turn for containerized builders.
    if (check.containerSkippable && isContainerized()) {
      skippedContainerChecks.push(check.name || check.command);
      continue;
    }

    const result = applyInFlightAwareness(check, runCheck(check, input, state.editedFiles), input);

    if (result.advisory) {
      console.error(`[smart-hooks] ${check.name || check.command}: SKIPPED (inconclusive)`);
      if (result.output) console.error(result.output);
    }

    if (!result.success && check.blocking) {
      // If the check itself output a JSON block decision, use it directly
      try {
        const parsed = JSON.parse(result.output);
        if (parsed.decision === "block" && parsed.reason) {
          blockReasons.push(parsed.reason);
          continue;
        }
      } catch {}
      blockReasons.push(`--- ${check.name} ---\n${result.output}`);
    }
  }

  clearState();

  if (skippedContainerChecks.length > 0) {
    console.error(
      `[smart-hooks] Skipped ${skippedContainerChecks.length} host-toolchain check(s) inside a ` +
        `containerized builder (safety downgrade, #158): ${skippedContainerChecks.join(", ")}`
    );
  }

  if (blockReasons.length > 0) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: ["CHECKS FAILED", "", ...blockReasons, "", "Fix the issues before stopping."].join("\n"),
      }) + "\n"
    );
    process.exit(2);
  }
}

// --- Main ---

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);

  let input = {};
  try {
    input = JSON.parse(lines.join(""));
    hookInput = input;
  } catch {
    process.exit(0);
  }

  const hookType = process.argv[2];
  if (hookType === "PreToolUse") handlePreToolUse(input);
  else if (hookType === "PostToolUse") handlePostToolUse(input);
  else if (hookType === "Stop") handleStop(input);

  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}

module.exports = {
  // Exported so the resolved hook chain can be asserted without spawning the
  // runner: the generated-rules merge is exactly where duplicate checks crept in
  // (a second whole-monorepo typecheck on Stop), and that is only visible in the
  // MERGED config, not in either input file alone.
  loadConfig,
  wrongCheckoutVitestReason,
  isContainerized,
  parseCompileErrorFiles,
  compileErrorNamesPath,
  classifyCompileFailure,
  // #913 — the posture/capacity gate, so a test can assert what a given posture runs
  // without spawning a build.
  policyGate,
};

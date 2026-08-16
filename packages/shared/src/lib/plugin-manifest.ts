/**
 * Plugin manifest contract (`kanban-plugin.json` at the plugin repo root).
 *
 * Pure string/JSON logic — no Node builtins — so it is client-safe through the
 * shared lib barrel: the client imports these types (and can re-validate a
 * manifest blob) without pulling anything server-only into the bundle. Reading
 * the manifest FILE from disk is the server's job (plugin.service.ts).
 *
 * Example manifest:
 * ```json
 * {
 *   "id": "refactor-safety-net",
 *   "name": "Refactor Safety Net",
 *   "version": "0.1.0",
 *   "skills": [{ "dir": ".claude/skills/requirement-extraction", "init": true }],
 *   "views": [{ "id": "coverage", "label": "Coverage", "kind": "iframe",
 *               "serve": { "command": "node tools/coverage/serve.mjs", "portEnv": "PORT",
 *                          "healthPath": "/health",
 *                          "env": { "COVERAGE_ROOT": "{{repoPath}}" } } }],
 *   "scripts": [{ "name": "coverage", "command": "npm run coverage", "cwd": "plugin",
 *                 "env": { "SOURCE_ROOT": "{{leadingRepoPath}}", "COVERAGE_ROOT": "{{repoPath}}" } }],
 *   "loops": [{ "name": "requirement-extraction", "skill": "requirement-extraction",
 *               "plan": { "command": "node tools/loop-plan.mjs --json", "cwd": "plugin",
 *                         "env": { "COVERAGE_ROOT": "{{repoPath}}" } } }],
 *   "butler": { "promptFragment": "butler-fragment.md" },
 *   "scaffold": { "profileTemplate": "profile-template.md",
 *                 "targetPath": "docs/analysis/_project-profile.md" }
 * }
 * ```
 */

/**
 * The derived identifiers (pref keys, the loop dedupe key, output-location vocabulary) live in
 * `plugin-keys.ts` and are re-exported here: this module is the documented import path for the
 * whole contract, and splitting them out was a cohesion fix, not an API change. Import either.
 */
import { errorMessage } from "./error-message.js";

export {
  pluginLoopUnitKey,
  parsePluginLoopUnitKey,
  pluginSkillName,
  pluginEnabledPreferenceKey,
  pluginLoopPausedPreferenceKey,
  pluginLoopConvergedPreferenceKey,
  pluginOutputLocationPreferenceKey,
  pluginSidecarRepoName,
  isPluginOutputLocation,
  PLUGIN_OUTPUT_LOCATIONS,
  DEFAULT_PLUGIN_OUTPUT_LOCATION,
} from "./plugin-keys.js";
export type { PluginOutputLocation } from "./plugin-keys.js";
// …and used here, so the parser's own skill-name derivation is the same one every consumer uses.
import { pluginSkillName } from "./plugin-keys.js";

/** The manifest file name, at the plugin repo root. */
export const PLUGIN_MANIFEST_FILENAME = "kanban-plugin.json";

/** Valid plugin slug: lowercase alphanumerics and dashes. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Valid loop `name`: letters, digits, `.`, `_`, `-` — and notably NO `:` (#250).
 *
 * The loop name is a SEGMENT of the `:`-joined dedupe key (`pluginLoopUnitKey`), and unit ids
 * legitimately contain colons (`billing:round-3` is the documented retry shape). If a loop name
 * could contain one too, loop `a` + unit `b:c` and loop `a:b` + unit `c` would produce the same
 * key, so one loop's unit would be read as "already ticketed" by the other and silently never
 * ticketed. Constraining the name — not the unit ids — makes the split unambiguous while leaving
 * planners free to compose ids. Whitespace and `%`/`\` are excluded for the same reason the LIKE
 * prefix is escaped: a name that is also a pattern is a name that matches the wrong rows.
 */
export const PLUGIN_LOOP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Where a manifest command runs: the plugin's own checkout or the project repo. */
export type PluginCwd = "plugin" | "repo";

/**
 * Who an entry is FOR (#456) — the board's capability rail renders the two differently.
 *
 * `operator` (the default, and what every pre-#456 manifest gets) is workflow: the things a
 * person running this pipeline presses. `developer` is diagnostics — a selftest over the
 * plugin's own fixtures, a dry-run planner dump, a skill the LOOP launches so pressing it by
 * hand duplicates loop work. Both are still reachable; the rail just collapses `developer`
 * entries under a "Diagnostics" disclosure so a seven-entry rail stops presenting five
 * debugging tools at the same weight as the one entry that is the actual job.
 */
export const PLUGIN_AUDIENCES = ["operator", "developer"] as const;
export type PluginAudience = (typeof PLUGIN_AUDIENCES)[number];

/** The audience an entry gets when its manifest says nothing — backward compatibility. */
export const DEFAULT_PLUGIN_AUDIENCE: PluginAudience = "operator";

export interface PluginSkillDef {
  /** Directory inside the plugin repo containing a SKILL.md (e.g. ".claude/skills/x"). */
  dir: string;
  /** One-line "what this skill does", surfaced next to its Run button. */
  description?: string;
  /**
   * Default workflow template for tickets launched from this skill — a builtin key
   * (`research-task`, `simple-ticket`, …) or a template name. Optional, and only a DEFAULT:
   * the launcher can always pick another in the UI.
   *
   * It exists because the plugin author knows something the board cannot infer. A mining
   * round that only writes analysis docs has nothing for a code reviewer to review, so
   * sending it through implement → review → done makes every round wait on a gate that can
   * only rubber-stamp it. Without this field the board's per-issue-type default silently wins.
   */
  workflow?: string;
  /** Who this skill is for (#456). Default `operator`; `developer` collapses it under Diagnostics. */
  audience?: PluginAudience;
  /**
   * Marks this as the plugin's ENTRY skill for a codebase that has never used the plugin
   * before (#462) — e.g. refactor-safety-net's API-documentation skill, which must run
   * once against a fresh project before the plugin's other skills produce useful output.
   * The board cannot infer this; only the plugin author knows which skill is the on-ramp.
   * Optional and absent by default, so a pre-#462 manifest keeps parsing unchanged.
   */
  init?: boolean;
}

export interface PluginViewServeDef {
  /** Shell command that starts the view's HTTP server. */
  command: string;
  /** Where the command runs. Default "plugin" — a view server ships with the plugin. */
  cwd?: PluginCwd;
  /** Env var name the server reads its port from (e.g. "PORT"). */
  portEnv?: string;
  /**
   * Path the readiness probe requests instead of "/". Default "/health"; a 404 there falls
   * back to probing "/" (so existing plugins with no dedicated endpoint keep working).
   * Prefer a cheap, dependency-free endpoint — the probe runs on every status check.
   */
  healthPath?: string;
  /** Extra env vars; values support {{repoPath}}/{{leadingRepoPath}}/{{projectName}}/{{pluginPath}}/{{port}}/{{boardUrl}}/{{projectId}}. */
  env?: Record<string, string>;
}

export interface PluginViewDef {
  id: string;
  label: string;
  /** Only "iframe" is supported in this slice. */
  kind: "iframe";
  description?: string;
  /** Who this view is for (#456). Default `operator`; `developer` collapses it under Diagnostics. */
  audience?: PluginAudience;
  serve: PluginViewServeDef;
}

export interface PluginScriptDef {
  name: string;
  /** Shell command. */
  command: string;
  /** Human-facing name for the UI; falls back to `name`. */
  label?: string;
  description?: string;
  /** Where the command runs: the plugin's own checkout or the project repo. Default "repo". */
  cwd?: PluginCwd;
  /** Who this script is for (#456). Default `operator`; `developer` collapses it under Diagnostics. */
  audience?: PluginAudience;
  /** Extra env vars; values support the same placeholders as view env. */
  env?: Record<string, string>;
}

/**
 * A converging, board-OWNED analysis loop.
 *
 * The plugin contributes only judgment-free state: `plan` is a deterministic
 * command that prints the work units still outstanding (JSON). The BOARD owns
 * everything else — it turns each unit into a ticket carrying the loop's skill,
 * and its own monitor starts them within the project's WIP limit, under the
 * Strategy Bullseye's provider selection and the auth-rotation ring (so a
 * quota-exhausted profile rotates mid-loop), through the normal review/merge
 * gates.
 *
 * What stops a loop: a plan reporting NO units and `converged: true`. That verdict is
 * PERSISTED per project (`pluginLoopConvergedPreferenceKey`) and the monitor then stops
 * advancing the loop, so the planner is not re-run forever. `units: [], converged: false`
 * is the deliberate "blocked, not done" state — the monitor keeps checking it.
 *
 * This is deliberately NOT a plugin-side agent runner: work that spawns agents
 * belongs on the board, where it is visible, governed, and resumable.
 */
export interface PluginLoopDef {
  name: string;
  /** Human-facing name for the UI; falls back to `name`. */
  label?: string;
  description?: string;
  /** Skill (a `skills[].dir` basename) each generated ticket is launched with. */
  skill: string;
  /** Deterministic command printing the outstanding work units as JSON. */
  plan: PluginLoopPlanDef;
  /**
   * Default workflow template for the tickets this loop creates (builtin key or name).
   * Falls back to the loop's skill's `workflow`, then to the board's default. Same reason as
   * `PluginSkillDef.workflow` — and it matters more here, because a loop creates tickets in
   * bulk with no human at the keyboard to pick one.
   */
  workflow?: string;
  /**
   * Safety stop: refuse to create more than this many tickets for one advance.
   * Defaults to `DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE`.
   */
  maxUnitsPerAdvance?: number;
  /**
   * Opt-in auto-land (#297): when a ticket this loop created finishes with committed
   * changes, the board merges its workspace automatically (still through the pre-merge
   * gate) instead of parking it at In Review until someone enables the global
   * `auto_merge_in_review` pref. For a document-producing loop the merge is what makes
   * the artifact visible to the planner (it reads the MAIN checkout), so without this
   * every round stalls on a human pressing Merge. Default false — landing product code
   * without review remains a deliberate, per-loop authorial decision.
   */
  autoLand?: boolean;
}

export interface PluginLoopPlanDef {
  /** Shell command whose stdout is the plan JSON (see `parsePluginLoopPlan`). */
  command: string;
  /** Where the command runs. Default "plugin" — a planner ships with the plugin. */
  cwd?: PluginCwd;
  /** Extra env vars; values support the same placeholders as script env. */
  env?: Record<string, string>;
}

/** One outstanding piece of loop work, as printed by a loop's `plan` command. */
export interface PluginLoopUnit {
  /**
   * Stable identity of the unit WITHIN the loop (e.g. "billing:round-3"). The
   * board derives the ticket's dedupe key from it, so a re-plan that still names
   * the same unit must reuse the same id or the loop will duplicate tickets.
   */
  id: string;
  title: string;
  /** The ticket body — the brief the skill runs against. */
  description?: string;
  /**
   * Repo-relative paths (in the loop's OUTPUT repo) of the artifacts this unit
   * produces (#288). The board renders them (markdown + version diff) on the
   * loop pane, so a document-producing pipeline doesn't need its own view server.
   */
  artifacts?: string[];
}

/** One action a human can take on a loop gate (e.g. "Approve" / "Needs revision"). */
export interface PluginLoopGateAction {
  /** Stable action id, passed back to the plugin's resolve command ([a-z0-9-]+). */
  id: string;
  label: string;
  /** `"text"` — this action carries a free-text input (e.g. revision feedback). */
  input?: "text";
}

/**
 * A human-approval gate (#286): the planner's structured way of saying "blocked on a
 * person" instead of burying it in `note`. The board renders an approval card; a chosen
 * action runs the plugin's deterministic `resolve` command (which mutates the plugin's
 * own state files — status.md checkboxes, registers, …), then re-advances the loop.
 * The doctrine holds: the plugin contributes deterministic commands, the board renders
 * UI and runs agents.
 */
export interface PluginLoopGate {
  /** Stable gate identity (e.g. "step-2:v1"). A NEW id is what re-notifies the user. */
  id: string;
  question: string;
  /** Repo-relative artifact(s) under review, rendered next to the question. */
  artifacts?: string[];
  actions: PluginLoopGateAction[];
  /**
   * Deterministic command applying a chosen action. Runs like a plan command
   * (same cwd/env/placeholder rules) with `GATE_ID`, `GATE_ACTION` env vars set
   * and — when the action declared `input` — `GATE_INPUT_FILE` naming a temp
   * file with the human's text (a file, never shell interpolation).
   */
  resolve: { command: string; cwd?: PluginCwd; env?: Record<string, string> };
}

export const PLUGIN_PROGRESS_STATES = [
  "done",
  "generating",
  "awaiting-approval",
  "needs-revision",
  "locked",
  "failed",
  "pending",
  // #479/#481 — the board's own reconciliation states. A planner only ever reports "generating"
  // for a step it has ticketed; that says a UNIT EXISTS, not that an agent is live. The board
  // overrides "generating" with one of these two once it can see the ticket's real workspace
  // state (see `reconcileProgressStepStates` in packages/server), so a planner never needs to
  // emit them itself — but they are accepted here too, for a planner that wants to say the same
  // thing up front.
  "planned",
  "stalled",
] as const;
export type PluginProgressState = (typeof PLUGIN_PROGRESS_STATES)[number];

/** One step of a pipeline plugin's declarative progress strip (#289). */
export interface PluginLoopProgressStep {
  id: string;
  label: string;
  state: PluginProgressState;
  /** e.g. "v2" — shown on the step chip. */
  version?: string;
  /** Repo-relative artifacts this step produced, openable from the stepper. */
  artifacts?: string[];
}

export const PLUGIN_CHECK_VERDICTS = ["pass", "warn", "fail"] as const;
export type PluginCheckVerdict = (typeof PLUGIN_CHECK_VERDICTS)[number];

/** A structured quality-check result (#290), rendered as a CI-style badge. */
export interface PluginLoopCheck {
  name: string;
  verdict: PluginCheckVerdict;
  detail?: string;
}

export interface PluginLoopPlan {
  units: PluginLoopUnit[];
  /**
   * The planner's own convergence verdict. Optional: an empty `units` list
   * already means converged, but a planner may report it explicitly (and may
   * report `converged: false` with no units to mean "blocked, not done").
   */
  converged?: boolean;
  /** Free-text note surfaced in the UI (e.g. "3/19 modules converged"). */
  note?: string;
  /** Human-approval gate the loop is blocked on (#286). Meaningful with `units: []`. */
  gate?: PluginLoopGate;
  /** Declarative pipeline progress rendered natively on the loop card (#289). */
  progress?: { steps: PluginLoopProgressStep[] };
  /** Structured check results for the most recent unit's verification (#290). */
  checks?: PluginLoopCheck[];
}

/** Cap on tickets one loop advance may create when the loop declares none. */
export const DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE = 10;

export interface PluginManifest {
  /** Unique slug ([a-z0-9-]+); doubles as the install directory name and pref-key segment. */
  id: string;
  name: string;
  version?: string;
  /** One-paragraph "what this plugin is for", shown in Settings → Plugins. */
  description?: string;
  skills?: PluginSkillDef[];
  views?: PluginViewDef[];
  scripts?: PluginScriptDef[];
  loops?: PluginLoopDef[];
  butler?: {
    /** Path (relative to the plugin root) of a markdown fragment appended to the butler prompt. */
    promptFragment: string;
  };
  scaffold?: {
    /** Path (relative to the plugin root) of the template to write into the project. */
    profileTemplate: string;
    /** Path (relative to the project repo root) the template is written to, if absent. */
    targetPath: string;
  };
}

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(`Invalid ${PLUGIN_MANIFEST_FILENAME}: ${message}`);
    this.name = "PluginManifestError";
  }
}

function fail(message: string): never {
  throw new PluginManifestError(message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`"${field}" must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") fail(`"${field}" must be a string`);
  return value.trim() || undefined;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") fail(`"${field}" must be a boolean`);
  return value;
}

function optionalEnv(value: unknown, field: string): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) fail(`"${field}" must be an object of string values`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") fail(`"${field}.${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

function optionalCwd(value: unknown, field: string): PluginCwd | undefined {
  if (value == null) return undefined;
  if (value !== "plugin" && value !== "repo") {
    fail(`"${field}" must be "plugin" or "repo" (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * `audience` is optional and absence is meaningful: it means "operator", so a manifest written
 * before #456 keeps rendering exactly as it did. It is left UNDEFINED here rather than
 * defaulted, so a consumer can still tell "unset" from "explicitly operator"; every renderer
 * resolves it through `DEFAULT_PLUGIN_AUDIENCE`.
 */
function optionalAudience(value: unknown, field: string): PluginAudience | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !(PLUGIN_AUDIENCES as readonly string[]).includes(value)) {
    fail(`"${field}" must be one of ${PLUGIN_AUDIENCES.join(", ")} (got ${JSON.stringify(value)})`);
  }
  return value as PluginAudience;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(`"${field}" must be an array`);
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(`"${field}" must be an object`);
  return value as Record<string, unknown>;
}

/**
 * A manifest-relative path must stay relative and inside the tree it is resolved
 * against (plugin root or project root) — reject absolute paths and `..` escapes
 * at parse time so no consumer has to re-check.
 */
function requireRelativePath(value: unknown, field: string): string {
  const text = requireString(value, field).replace(/\\/g, "/");
  if (/^([a-zA-Z]:)?\//.test(text)) fail(`"${field}" must be a relative path (got "${text}")`);
  const segments = text.split("/");
  if (segments.includes("..")) fail(`"${field}" must not contain ".." (got "${text}")`);
  // A trailing slash is not cosmetic: consumers derive a skill's NAME from the dir's basename, and
  // ".claude/skills/x/" yielded an empty name at one site and "x" at another — a skill that shows
  // up in the butler roster and cannot be launched. Reject it where it is cheapest to explain.
  if (text.endsWith("/")) fail(`"${field}" must not end with a slash (got "${text}")`);
  return text;
}

/**
 * Parse + validate a `kanban-plugin.json` blob. Accepts the raw JSON text or an
 * already-parsed object; throws `PluginManifestError` with a field-precise
 * message on any violation. Unknown top-level fields are ignored (forward compat).
 */
export function parsePluginManifest(input: string | unknown): PluginManifest {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      fail(`not valid JSON — ${errorMessage(err)}`);
    }
  }
  const obj = asRecord(raw, "manifest");

  const id = requireString(obj.id, "id");
  if (!PLUGIN_ID_PATTERN.test(id)) fail(`"id" must match ${PLUGIN_ID_PATTERN} (got "${id}")`);
  const name = requireString(obj.name, "name");
  const version = optionalString(obj.version, "version");
  const description = optionalString(obj.description, "description");

  const skills = obj.skills == null ? undefined : requireArray(obj.skills, "skills").map((entry, i) => {
    const rec = asRecord(entry, `skills[${i}]`);
    return {
      dir: requireRelativePath(rec.dir, `skills[${i}].dir`),
      description: optionalString(rec.description, `skills[${i}].description`),
      workflow: optionalString(rec.workflow, `skills[${i}].workflow`),
      audience: optionalAudience(rec.audience, `skills[${i}].audience`),
      init: optionalBoolean(rec.init, `skills[${i}].init`),
    };
  });

  const seenViewIds = new Set<string>();
  const views = obj.views == null ? undefined : requireArray(obj.views, "views").map((entry, i) => {
    const rec = asRecord(entry, `views[${i}]`);
    const viewId = requireString(rec.id, `views[${i}].id`);
    if (seenViewIds.has(viewId)) fail(`duplicate view id "${viewId}"`);
    seenViewIds.add(viewId);
    if (rec.kind !== "iframe") fail(`views[${i}].kind must be "iframe" (got ${JSON.stringify(rec.kind)})`);
    const serve = asRecord(rec.serve, `views[${i}].serve`);
    return {
      id: viewId,
      label: requireString(rec.label, `views[${i}].label`),
      kind: "iframe" as const,
      description: optionalString(rec.description, `views[${i}].description`),
      audience: optionalAudience(rec.audience, `views[${i}].audience`),
      serve: {
        command: requireString(serve.command, `views[${i}].serve.command`),
        cwd: optionalCwd(serve.cwd, `views[${i}].serve.cwd`),
        portEnv: optionalString(serve.portEnv, `views[${i}].serve.portEnv`),
        healthPath: optionalString(serve.healthPath, `views[${i}].serve.healthPath`),
        env: optionalEnv(serve.env, `views[${i}].serve.env`),
      },
    };
  });

  const seenScriptNames = new Set<string>();
  const scripts = obj.scripts == null ? undefined : requireArray(obj.scripts, "scripts").map((entry, i) => {
    const rec = asRecord(entry, `scripts[${i}]`);
    const scriptName = requireString(rec.name, `scripts[${i}].name`);
    if (seenScriptNames.has(scriptName)) fail(`duplicate script name "${scriptName}"`);
    seenScriptNames.add(scriptName);
    return {
      name: scriptName,
      command: requireString(rec.command, `scripts[${i}].command`),
      label: optionalString(rec.label, `scripts[${i}].label`),
      description: optionalString(rec.description, `scripts[${i}].description`),
      cwd: optionalCwd(rec.cwd, `scripts[${i}].cwd`),
      audience: optionalAudience(rec.audience, `scripts[${i}].audience`),
      env: optionalEnv(rec.env, `scripts[${i}].env`),
    };
  });

  const skillNames = new Set((skills ?? []).map((s) => pluginSkillName(s.dir)));
  const seenLoopNames = new Set<string>();
  const loops = obj.loops == null ? undefined : requireArray(obj.loops, "loops").map((entry, i) => {
    const rec = asRecord(entry, `loops[${i}]`);
    const loopName = requireString(rec.name, `loops[${i}].name`);
    if (!PLUGIN_LOOP_NAME_PATTERN.test(loopName)) {
      fail(`"loops[${i}].name" must match ${PLUGIN_LOOP_NAME_PATTERN} (got "${loopName}") — the name is a segment of the ticket dedupe key, so a ":" in it would collide with a unit id`);
    }
    if (seenLoopNames.has(loopName)) fail(`duplicate loop name "${loopName}"`);
    seenLoopNames.add(loopName);
    const skill = requireString(rec.skill, `loops[${i}].skill`);
    // A loop that names a skill the manifest doesn't declare would create tickets
    // whose skill never materializes into the worktree — fail at parse time.
    if (!skillNames.has(skill)) {
      fail(`loops[${i}].skill "${skill}" is not one of the manifest's skills`);
    }
    const plan = asRecord(rec.plan, `loops[${i}].plan`);
    let maxUnits: number | undefined;
    if (rec.maxUnitsPerAdvance != null) {
      if (typeof rec.maxUnitsPerAdvance !== "number" || !Number.isInteger(rec.maxUnitsPerAdvance) || rec.maxUnitsPerAdvance < 1) {
        fail(`"loops[${i}].maxUnitsPerAdvance" must be a positive integer`);
      }
      maxUnits = rec.maxUnitsPerAdvance;
    }
    let autoLand: boolean | undefined;
    if (rec.autoLand != null) {
      if (typeof rec.autoLand !== "boolean") fail(`"loops[${i}].autoLand" must be a boolean`);
      autoLand = rec.autoLand;
    }
    return {
      name: loopName,
      label: optionalString(rec.label, `loops[${i}].label`),
      description: optionalString(rec.description, `loops[${i}].description`),
      skill,
      workflow: optionalString(rec.workflow, `loops[${i}].workflow`),
      maxUnitsPerAdvance: maxUnits,
      autoLand,
      plan: {
        command: requireString(plan.command, `loops[${i}].plan.command`),
        cwd: optionalCwd(plan.cwd, `loops[${i}].plan.cwd`),
        env: optionalEnv(plan.env, `loops[${i}].plan.env`),
      },
    };
  });

  const butler = obj.butler == null ? undefined : (() => {
    const rec = asRecord(obj.butler, "butler");
    return { promptFragment: requireRelativePath(rec.promptFragment, "butler.promptFragment") };
  })();

  const scaffold = obj.scaffold == null ? undefined : (() => {
    const rec = asRecord(obj.scaffold, "scaffold");
    const targetPath = requireRelativePath(rec.targetPath, "scaffold.targetPath");
    // The scaffold is plugin-authored content written into the project on ENABLE, before any
    // script consent. Plugins are trusted-by-install, so this crosses no new boundary — but
    // `.git/hooks/pre-commit` would be executed by every later git operation in that repo, which
    // is a category of effect nobody enabling a plugin expects. Cheap to exclude.
    if (/^\.git(\/|$)/i.test(targetPath)) {
      fail(`"scaffold.targetPath" must not write inside ".git" (got "${targetPath}")`);
    }
    return {
      profileTemplate: requireRelativePath(rec.profileTemplate, "scaffold.profileTemplate"),
      targetPath,
    };
  })();

  return { id, name, version, description, skills, views, scripts, loops, butler, scaffold };
}

/**
 * Parse a loop `plan` command's stdout.
 *
 * Tolerant on purpose: a planner is a third-party script, and the shell it runs
 * under happily prepends banners (npm notices, tsx warnings), so the LAST JSON
 * value in the output wins rather than requiring the whole stream to be JSON. A
 * bare array is accepted as `{ units: [...] }`. Anything else throws
 * `PluginManifestError` so the route answers 400 with the offending output.
 */
export function parsePluginLoopPlan(stdout: string): PluginLoopPlan {
  const text = stdout.trim();
  if (!text) fail("loop plan command printed no output");

  // Scan back from the end for the last balanced JSON object/array.
  let raw: unknown;
  let parsed = false;
  for (let start = text.length - 1; start >= 0 && !parsed; start--) {
    const ch = text[start];
    if (ch !== "{" && ch !== "[") continue;
    try {
      raw = JSON.parse(text.slice(start));
      parsed = true;
    } catch {
      /* not a complete value at this offset — keep scanning left */
    }
  }
  if (!parsed) fail(`loop plan output is not JSON: ${text.slice(-400)}`);

  const obj = Array.isArray(raw) ? { units: raw } : asRecord(raw, "loop plan");
  const seen = new Set<string>();
  const units = requireArray(obj.units ?? [], "loop plan units").map((entry, i) => {
    const rec = asRecord(entry, `units[${i}]`);
    const unitId = requireString(rec.id, `units[${i}].id`);
    if (seen.has(unitId)) fail(`loop plan repeats unit id "${unitId}"`);
    seen.add(unitId);
    return {
      id: unitId,
      title: requireString(rec.title, `units[${i}].title`),
      description: optionalString(rec.description, `units[${i}].description`),
      artifacts: optionalArtifactPaths(rec.artifacts, `units[${i}].artifacts`),
    };
  });

  if (obj.converged != null && typeof obj.converged !== "boolean") fail(`"converged" must be a boolean`);
  return {
    units,
    converged: (obj.converged as boolean | undefined) ?? units.length === 0,
    note: optionalString(obj.note, "note"),
    gate: parseLoopGate(obj.gate),
    progress: parseLoopProgress(obj.progress),
    checks: parseLoopChecks(obj.checks),
  };
}

/** Repo-relative artifact paths — same escape rules as manifest paths. */
function optionalArtifactPaths(value: unknown, field: string): string[] | undefined {
  if (value == null) return undefined;
  return requireArray(value, field).map((entry, i) => requireRelativePath(entry, `${field}[${i}]`));
}

const GATE_ACTION_ID_PATTERN = /^[a-z0-9-]+$/;

function parseLoopGate(value: unknown): PluginLoopGate | undefined {
  if (value == null) return undefined;
  const rec = asRecord(value, "gate");
  const actions = requireArray(rec.actions, "gate.actions").map((entry, i) => {
    const a = asRecord(entry, `gate.actions[${i}]`);
    const actionId = requireString(a.id, `gate.actions[${i}].id`);
    if (!GATE_ACTION_ID_PATTERN.test(actionId)) {
      fail(`"gate.actions[${i}].id" must match ${GATE_ACTION_ID_PATTERN} (got "${actionId}")`);
    }
    if (a.input != null && a.input !== "text") fail(`"gate.actions[${i}].input" must be "text" when present`);
    return {
      id: actionId,
      label: requireString(a.label, `gate.actions[${i}].label`),
      input: a.input as "text" | undefined,
    };
  });
  if (actions.length === 0) fail(`"gate.actions" must not be empty`);
  const resolve = asRecord(rec.resolve, "gate.resolve");
  return {
    id: requireString(rec.id, "gate.id"),
    question: requireString(rec.question, "gate.question"),
    artifacts: optionalArtifactPaths(rec.artifacts, "gate.artifacts"),
    actions,
    resolve: {
      command: requireString(resolve.command, "gate.resolve.command"),
      cwd: optionalCwd(resolve.cwd, "gate.resolve.cwd"),
      env: optionalEnv(resolve.env, "gate.resolve.env"),
    },
  };
}

function parseLoopProgress(value: unknown): { steps: PluginLoopProgressStep[] } | undefined {
  if (value == null) return undefined;
  const rec = asRecord(value, "progress");
  const steps = requireArray(rec.steps, "progress.steps").map((entry, i) => {
    const s = asRecord(entry, `progress.steps[${i}]`);
    const state = requireString(s.state, `progress.steps[${i}].state`);
    if (!(PLUGIN_PROGRESS_STATES as readonly string[]).includes(state)) {
      fail(`"progress.steps[${i}].state" must be one of ${PLUGIN_PROGRESS_STATES.join(", ")} (got "${state}")`);
    }
    return {
      id: requireString(s.id, `progress.steps[${i}].id`),
      label: requireString(s.label, `progress.steps[${i}].label`),
      state: state as PluginProgressState,
      version: optionalString(s.version, `progress.steps[${i}].version`),
      artifacts: optionalArtifactPaths(s.artifacts, `progress.steps[${i}].artifacts`),
    };
  });
  return { steps };
}

function parseLoopChecks(value: unknown): PluginLoopCheck[] | undefined {
  if (value == null) return undefined;
  return requireArray(value, "checks").map((entry, i) => {
    const c = asRecord(entry, `checks[${i}]`);
    const verdict = requireString(c.verdict, `checks[${i}].verdict`);
    if (!(PLUGIN_CHECK_VERDICTS as readonly string[]).includes(verdict)) {
      fail(`"checks[${i}].verdict" must be one of ${PLUGIN_CHECK_VERDICTS.join(", ")} (got "${verdict}")`);
    }
    return {
      name: requireString(c.name, `checks[${i}].name`),
      verdict: verdict as PluginCheckVerdict,
      detail: optionalString(c.detail, `checks[${i}].detail`),
    };
  });
}

export interface PluginPlaceholderVars {
  /** Where this plugin's output goes — the project's leading repo, or a sidecar repo. */
  repoPath?: string;
  /** The project's leading (product) repo, regardless of output location. Lets a manifest
   *  read the source from `{{leadingRepoPath}}` while writing output to `{{repoPath}}`. */
  leadingRepoPath?: string;
  projectName?: string;
  pluginPath?: string;
  port?: number | string;
  /** Externally REACHABLE base URL of the board's REST API — scheme+host+port, no trailing
   *  slash (e.g. `http://localhost:3001`). This is what a plugin view server, script, or loop
   *  planner calls to read board data. In dev the backend binds an INTERNAL port behind the
   *  stable proxy; this is always the public (proxy) URL, never the internal one. */
  boardUrl?: string;
  /** The board project the view/script/loop was started FOR — the id to pass as `projectId`
   *  in board API calls. */
  projectId?: string;
}

/**
 * Substitute the supported `{{placeholder}}`s in a manifest env value or template
 * text. Unknown placeholders are left as-is; a placeholder whose var is not
 * provided is also left as-is (so a later pass — e.g. `{{port}}` at serve time —
 * can fill it).
 */
export function substitutePluginPlaceholders(text: string, vars: PluginPlaceholderVars): string {
  let out = text;
  if (vars.repoPath !== undefined) out = out.replace(/\{\{repoPath}}/g, vars.repoPath);
  if (vars.leadingRepoPath !== undefined) out = out.replace(/\{\{leadingRepoPath}}/g, vars.leadingRepoPath);
  if (vars.projectName !== undefined) out = out.replace(/\{\{projectName}}/g, vars.projectName);
  if (vars.pluginPath !== undefined) out = out.replace(/\{\{pluginPath}}/g, vars.pluginPath);
  if (vars.port !== undefined) out = out.replace(/\{\{port}}/g, String(vars.port));
  if (vars.boardUrl !== undefined) out = out.replace(/\{\{boardUrl}}/g, vars.boardUrl);
  if (vars.projectId !== undefined) out = out.replace(/\{\{projectId}}/g, vars.projectId);
  return out;
}

/** Apply placeholder substitution to every value of a manifest env map. */
export function substitutePluginEnv(
  env: Record<string, string> | undefined,
  vars: PluginPlaceholderVars,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = substitutePluginPlaceholders(v, vars);
  return out;
}

/**
 * Count unfilled `TODO:` markers left in a scaffold file's content.
 *
 * A plugin's `scaffold.profileTemplate` ships with `TODO:` markers for a human
 * to fill in; a script or loop `plan` command that reads the scaffold before
 * that happens fails with a confusing stack (or its own domain-specific "no
 * source files under TODO: e.g. src" error) instead of saying why. This is the
 * one shared signal both the enable report and the pre-run gate key off.
 */
export function countScaffoldPlaceholders(content: string): number {
  // Ignore `TODO:` inside inline-code spans. A scaffold template explains itself
  // ("Fill in every `TODO:` marker before running the pipeline"), and counting
  // that sentence made a FULLY filled-in profile report a leftover placeholder
  // forever — the loop gate then refused to run against a correct scaffold, which
  // is worse than the confusing failure the gate exists to prevent. A marker shown
  // as code is documentation ABOUT the marker; a real placeholder is a value
  // (`"language": "TODO: ts|js|..."`), which is never wrapped in backticks.
  return (content.replace(/`[^`\n]*`/g, "").match(/TODO:/g) ?? []).length;
}

/** Loop-plan stdout parser (split out of plugin-manifest.ts; re-exported there). */
import { extractModelJson, ModelJsonError } from "./model-json.js";
import {
  asRecord, fail, optionalCwd, optionalEnv, optionalString, requireArray, requireRelativePath, requireString,
} from "./plugin-manifest-fields.js";
import type { PluginCwd } from "./plugin-manifest-fields.js";

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
  /**
   * The board ticket this step resolved to, attached by `reconcileProgressStepStates` (#481).
   *
   * A planner cannot supply this — it knows unit ids, not board issues. The board joins them
   * anyway to decide `planned`/`stalled`, so carrying the result costs nothing and is what
   * lets the stepper offer a Start button instead of telling the user to go find the ticket.
   */
  ticket?: { issueId: string; issueNumber: number | null };
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
  /**
   * Unit ids still outstanding but waiting for a human (jira-sync needs-human, #1718): no ticket is
   * created for them, and an already-open ticket of such a unit is NOT closed as "resolved".
   */
  held?: string[];
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

/** The keys a loop plan may declare — at least one must be present (#662). */
const PLAN_KEYS = ["units", "converged", "note", "gate", "progress", "checks"] as const;

export function parsePluginLoopPlan(
  stdout: string,
  opts: { /** The producer clipped this payload's FRONT (`stdoutTruncated`). */ truncated?: boolean } = {},
): PluginLoopPlan {
  // #662: a clipped plan must never be READ, only reported. Tolerant extraction (#550) can
  // recover some object out of the middle of a front-clipped stream, and a plan is a WORK
  // LIST — a fragment that parses is strictly worse than one that throws, because the loop
  // then reports progress it did not make. Refuse before looking at the bytes.
  if (opts.truncated) {
    fail(
      "loop plan output was truncated before it could be read, so it is a fragment, not a plan — " +
        "raise the structured stdout cap or make the planner emit less",
    );
  }

  const text = stdout.trim();
  if (!text) fail("loop plan command printed no output");

  // #550: the balanced scan lives in `model-json` now, shared with every other place that
  // reads JSON out of a model's or a script's output. `prefer: "last"` keeps this call's
  // distinguishing behaviour — the noise here comes BEFORE the value (npm notices, tsx
  // warnings), so the last value in the stream is the planner's answer.
  let raw: unknown;
  try {
    raw = extractModelJson(text, { prefer: "last" });
  } catch (err) {
    fail(`loop plan output is not JSON: ${err instanceof ModelJsonError ? err.tail : text.slice(-400)}`);
  }

  const obj = Array.isArray(raw) ? { units: raw } : asRecord(raw, "loop plan");
  // #662, the second half: even without a truncation flag, the tolerant extractor can hand
  // back an object that is not a plan at all — e.g. ONE unit recovered from the middle of a
  // clipped stream. With `obj.units ?? []` below that used to parse as an empty plan, and an
  // empty plan defaults to `converged: true`: a clipped work list silently ENDED the loop.
  // A real plan always carries at least one of its own keys.
  if (!PLAN_KEYS.some((key) => obj[key] !== undefined)) {
    fail(
      `loop plan output is not a plan: expected an object with ${PLAN_KEYS.map((k) => `"${k}"`).join("/")}, got keys ` +
        `${Object.keys(obj).map((k) => `"${k}"`).join(", ") || "(none)"}`,
    );
  }
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
    ...(obj.held !== undefined ? { held: requireArray(obj.held, "held").map((h, i) => requireString(h, `held[${i}]`)) } : {}),
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

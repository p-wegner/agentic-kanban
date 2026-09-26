#!/usr/bin/env node
// @board-hook-version: 2
/**
 * Hook posture policy (#913) — how much the Stop/PostToolUse chain is allowed to spend.
 *
 * After 4fa6d0fee7 the chain no longer BLOCKS on a green Stop, but it stayed
 * one-size: every worktree paid a typecheck plus a related-test run on every Stop,
 * and the generated stack rules (`.claude/smart-hooks-rules.json`) went straight to
 * `execSync` without ever asking `capacityHold` whether the box could afford it.
 *
 * The board already resolves a per-project RISK POSTURE (#911/#912,
 * `packages/shared/src/lib/risk-posture.ts`) and renders it into every worktree's
 * ticket-context file (`CLAUDE.local.md`, `buildRiskPostureSection`). That is the
 * one input this module reads, so a project that has declared it is going fast does
 * not have to declare it a second time for its hooks.
 *
 * The levels, and what each one buys (mirrors `builderStopChecks` in
 * `packages/server/src/services/risk-posture.service.ts`, the per-level posture table):
 *
 *   strict    typecheck + related tests, and NOT capacity-gated — a strict project
 *             wants the answer even when the box is tight, because for it a slow
 *             turn is cheaper than an unverified one. (`tests-and-typecheck`)
 *   standard  typecheck + related tests, capacity-gated (today's behaviour).
 *             (`tests-capacity-gated`)
 *   iterate   same builder Stop-chain policy as `standard` — the two postures differ
 *             at the pre-merge gate and the base sweep, not at this hook.
 *             (`tests-capacity-gated`)
 *   flow      same builder Stop-chain policy as `standard`/`iterate` — `flow` differs
 *             at the merge gate and the base sweep, not at this hook.
 *             (`tests-capacity-gated`)
 *   fast      typecheck only, capacity-gated. Tests move to the train gate.
 *             (`typecheck-only`)
 *   sprint    safety guards only. No tsc, no vitest, no generated stack rules.
 *             (`none`)
 *
 * `hook-posture-lockstep.test.ts` fails if `RISK_POSTURES` (the shared source of truth)
 * gains a level that is missing here — this file cannot `require()` that TS module at
 * runtime (it is copied byte-for-byte into a scaffolded worktree's `.claude/hooks/`,
 * outside any build step), so the lockstep test is what keeps the two in sync instead.
 *
 * THE ONE INVARIANT: safety guards never change with posture. A check marked
 * `alwaysRun` (validate-command-safety, the uncommitted/cleanup reminders, the
 * cross-worktree and vital-file guards) runs identically under `sprint` and under
 * `strict`. Posture buys speed by skipping SPECULATIVE CORRECTNESS work — the
 * pre-merge gate re-runs all of it — and never by skipping a guard whose whole job
 * is to refuse something destructive.
 *
 * Resolution order (first hit wins):
 *   1. SMART_HOOKS_POSTURE env var — the escape hatch, and what the board sets when
 *      it wants to override the file for one launch.
 *   2. The `## Risk posture` section of the worktree's ticket-context file.
 *   3. `standard` — the same fail-closed default `resolveRiskPosture` uses. An
 *      unreadable/absent/garbled posture must never resolve to a WEAKER one.
 */

const fs = require("fs");
const path = require("path");

/**
 * Mirrors RISK_POSTURES in packages/shared/src/lib/risk-posture.ts — every level that dial
 * can resolve to, whether or not its builder Stop-chain policy differs from `standard`'s.
 * Kept in lockstep by `hook-posture-lockstep.test.ts`, not by hand.
 */
const POSTURES = ["strict", "standard", "iterate", "fast", "sprint", "flow"];
const DEFAULT_POSTURE = "standard";

/** Mirrors TICKET_CONTEXT_FILENAME in packages/shared/src/lib/ticket-context.ts. */
const TICKET_CONTEXT_FILENAME = "CLAUDE.local.md";

/** Built from POSTURES so a level added there is matched here without a second edit. */
const POSTURE_ALTERNATION = POSTURES.join("|");

/**
 * Policy per posture. `expensiveChecks` gates the speculative correctness work
 * (typecheck / tests / generated stack rules); `capacityGated` decides whether
 * those spawns consult `capacityHold` first.
 */
const POLICIES = {
  strict: { typecheck: true, tests: true, generatedRules: true, capacityGated: false },
  standard: { typecheck: true, tests: true, generatedRules: true, capacityGated: true },
  // `iterate`/`flow` want the same builder Stop-chain policy as `standard`
  // (`builderStopChecks: "tests-capacity-gated"` in risk-posture.service.ts) — spelled out
  // as their own rows, not a fallthrough, so a future level with a DIFFERENT policy cannot
  // be silently misread as `standard`'s row the way these two were before this table
  // enumerated every RISK_POSTURES member.
  iterate: { typecheck: true, tests: true, generatedRules: true, capacityGated: true },
  flow: { typecheck: true, tests: true, generatedRules: true, capacityGated: true },
  fast: { typecheck: true, tests: false, generatedRules: false, capacityGated: true },
  sprint: { typecheck: false, tests: false, generatedRules: false, capacityGated: true },
};

/** Any value that is not an exact posture resolves to `standard` (fail closed). */
function normalizePosture(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return POSTURES.includes(v) ? v : DEFAULT_POSTURE;
}

/**
 * Pull the posture out of a ticket-context file's `## Risk posture` section.
 *
 * The section is generated by `buildRiskPostureSection`, which writes
 * `This project runs under **Standard** risk posture. …` — so the label is what is
 * on disk, not the slug. Match the label case-insensitively rather than reparsing
 * the whole markdown; a ticket-level `risk:<posture>` tag (documented in the same
 * section) is honoured too, since it overrides the project default for that ticket.
 *
 * BOTH patterns are matched ONLY inside the `## Risk posture` section, never over the
 * whole file. The ticket DESCRIPTION and the context primer are written into the same
 * file ABOVE that section, so a whole-file `risk:(strict|…|sprint)` scan reads any
 * prose that happens to quote a tag — e.g. a ticket whose description says "a ticket
 * tagged `risk:sprint` skips the review" — as an actual tag. Since the tag branch WINS
 * over the declared sentence, that silently downgrades a `strict` project's Stop chain
 * to `sprint` (no typecheck, no tests) while still reporting the ticket-context file as
 * its source. A posture may only ever be weakened deliberately and visibly.
 *
 * Returns null when the file has no posture section at all, so the caller can tell
 * "absent" from "explicitly standard".
 */
function parsePostureFromTicketContext(text) {
  const section = riskPostureSection(String(text || ""));
  if (!section) return null;
  const tagged = new RegExp(`\\brisk:(${POSTURE_ALTERNATION})\\b`, "i").exec(section);
  const declared = new RegExp(`runs under \\*\\*(${POSTURE_ALTERNATION})\\*\\* risk posture`, "i").exec(section);
  // A ticket-level tag beats the project default, matching the sentence the section
  // itself prints. The generic prose line that DOCUMENTS the tag syntax uses the
  // literal `risk:<posture>`, which this regex deliberately does not match.
  const hit = tagged || declared;
  return hit ? normalizePosture(hit[1]) : null;
}

/**
 * The body of the `## Risk posture` section, or null when the file has none. Ends at the
 * next markdown heading of the same-or-higher level, so the following section's prose
 * (board-feedback routing, which quotes ticket text) is outside the match window.
 */
function riskPostureSection(body) {
  const start = /^##\s+Risk posture\s*$/im.exec(body);
  if (!start) return null;
  const rest = body.slice(start.index + start[0].length);
  const end = /^#{1,2}\s+\S/m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

function readTicketContextPosture(projectDir) {
  try {
    return parsePostureFromTicketContext(
      fs.readFileSync(path.join(projectDir, TICKET_CONTEXT_FILENAME), "utf8"),
    );
  } catch {
    return null;
  }
}

/**
 * Resolve the posture for this worktree, plus WHERE it came from — the source is
 * part of the answer, because a hook that skipped a check has to be able to say why.
 */
function resolvePosture(projectDir) {
  const fromEnv = process.env.SMART_HOOKS_POSTURE;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return { posture: normalizePosture(fromEnv), source: "SMART_HOOKS_POSTURE" };
  }
  const fromFile = readTicketContextPosture(projectDir);
  if (fromFile) return { posture: fromFile, source: TICKET_CONTEXT_FILENAME };
  return { posture: DEFAULT_POSTURE, source: "default" };
}

function policyFor(posture) {
  return POLICIES[normalizePosture(posture)];
}

/**
 * Which expensive-check bucket a check falls in, from its command.
 *
 * Deliberately command-shaped rather than config-flag-shaped: the checks that
 * actually cost minutes are the two scoped hooks and the GENERATED stack rules, and
 * a generated rule carries no hand-authored flag we could key off (that is exactly
 * why it bypassed the capacity gate). A check we cannot classify counts as neither
 * and is left alone — posture must not silently disable something it does not
 * understand.
 */
function classifyCheck(check) {
  if (check && check.alwaysRun === true) return "safety";
  const command = String((check && check.command) || "");
  const name = String((check && check.name) || "");
  // The NAME is matched too, because a project can point the same bucket at its own
  // script — the hand-authored config's names ("Typecheck (edited packages only)",
  // "Vitest (edited files only)") are what a reader recognises, and a stack whose
  // typecheck hook is not literally `scoped-typecheck.js` should still be gated.
  if (/scoped-typecheck\.js/.test(command) || /\btypecheck\b/i.test(name)) return "typecheck";
  if (/scoped-vitest\.js/.test(command) || /\b(vitest|tests?)\b/i.test(name)) return "tests";
  if (check && check.generated === true) return "generatedRules";
  return "other";
}

/**
 * Should this check run under `posture`? Returns `{ run, reason }`.
 *
 * A safety check ALWAYS runs — that is the invariant this module exists to keep, and
 * it is checked before anything else so no posture can reach past it.
 */
function checkAllowedUnderPosture(check, posture) {
  const kind = classifyCheck(check);
  if (kind === "safety" || kind === "other") return { run: true, kind, reason: null };
  const policy = policyFor(posture);
  if (policy[kind]) return { run: true, kind, reason: null };
  return {
    run: false,
    kind,
    reason:
      `${(check && check.name) || kind} SKIPPED — risk posture is "${normalizePosture(posture)}", ` +
      `which does not run ${kind === "generatedRules" ? "generated stack rules" : kind} on this hook. ` +
      `NOTHING was verified and nothing is claimed to have passed; the pre-merge gate still runs ` +
      `the full suite. Set SMART_HOOKS_POSTURE=standard for one run to get it back.`,
  };
}

module.exports = {
  POSTURES,
  DEFAULT_POSTURE,
  POLICIES,
  TICKET_CONTEXT_FILENAME,
  normalizePosture,
  parsePostureFromTicketContext,
  resolvePosture,
  policyFor,
  classifyCheck,
  checkAllowedUnderPosture,
};

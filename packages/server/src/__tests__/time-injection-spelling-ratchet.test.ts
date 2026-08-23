// @gate:always-run — scans every package's src tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  walkPackageSources,
  compareRatchet,
  parseGuardSource,
  forEachNode,
  unwrapExpression,
} from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * One vocabulary for injected time (#614), asserted on the AST (#721).
 *
 * CLAUDE.md names `now?: string` for services that persist timestamps. In practice the
 * same parameter is spelled many ways, which is why a reader cannot tell whether a
 * function is time-injectable without opening it, and why new code picks whichever
 * spelling it saw last.
 *
 * Two sanctioned spellings, because there are genuinely two jobs:
 *   - `now?: string`   — ISO, for code that PERSISTS the value (it goes into a column).
 *   - `nowMs?: number` — epoch ms, for pure arithmetic (ageMs, TTL comparisons).
 * Everything else is grandfathered at today's count and may only shrink.
 *
 * ## What #721 found, and what changed
 *
 * The first version matched a regex over six hard-coded NAMES
 * (`now|nowMs|nowIso|nowOverride|nowDate|clock`). So it could only ever catch the reuse of
 * a spelling someone had already used — which is the opposite of what a spelling ratchet is
 * for. `asOf: number` and `currentTimeMs: number` were both injected and both passed, and
 * the root CLAUDE.md's claim that "adding a tenth spelling fails that gate" was simply
 * false.
 *
 * The predicate is now about the SHAPE of an injection point, in three tiers, and a name it
 * has never seen can fail it:
 *
 *   1. **strong name** — a `now` / `clock` / `instant` / `moment` word, or an `asOf…`
 *      prefix. In this codebase these words name an instant and nothing else.
 *   2. **weak time word made specific** — a `time` / `timestamp` / `date` / `epoch` word
 *      TOGETHER WITH a currentness marker (`current`, `wall`, `today`, `present`), or else
 *      carried by the override SHAPE (optional, or defaulted). `currentTimeMs` lands here;
 *      a DTO's `timestamp: string` and a commit's `commitDateIso: string` do not, which is
 *      deliberate — see below.
 *   3. **semantic, name-independent** — any time-typed parameter or property whose default
 *      is a clock read, or which is coalesced with one (`p ?? Date.now()`,
 *      `p ?? new Date().toISOString()`, `p ? … : new Date()`). This tier owes nothing to
 *      the name at all, and it is what makes a genuinely novel spelling detectable.
 *
 * Names that measure something ABOUT time rather than naming an instant are excluded by
 * word (`pct`, `budget`, `timeout`, `duration`, `elapsed`, `age`, …). That is not
 * cosmetic: `nowPct` (a timeline's "today" marker position) and a bare `epoch` (a
 * prefs-cache generation counter) are the two false positives the tiers would otherwise
 * report, and a baseline that carries false positives trains people to add entries instead
 * of catching drift. For the same reason a plain `timestamp: string` DTO field is not an
 * injection point: there are 19 of them, none injectable, and none renameable to `now`.
 *
 * Still deliberately a SPELLING ratchet, not the raw-`Date.now()` ratchet #614 proposed.
 * That one keys off a staleness VOCABULARY (`stale|expir|ttl|ageMs|idle` near a date call),
 * and measuring it produced 51 candidate files whose majority are
 * `updatedAt: new Date().toISOString()` writes — legitimate timestamp writes, not staleness
 * reads.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const SCAN_ROOTS = ["server/src", "shared/src", "mcp-server/src", "client/src"];

/** The types an injected clock value can have here. Anything else is not a time. */
const TIME_TYPES = new Set(["string", "number", "Date", "() => number", "() => Date", "() => string"]);

/** Tier 1 — words that name an instant and nothing else in this codebase. */
const STRONG_WORDS = new Set(["now", "clock", "instant", "moment"]);
/** Tier 2 — words that MIGHT name an instant; they need an anchor or the override shape. */
const WEAK_WORDS = new Set(["time", "timestamp", "date", "epoch"]);
/**
 * What makes a weak time word specific enough to be an injection point: a word saying the
 * value is the CURRENT time. A unit alone (`Ms`, `Iso`) is not enough — `commitDateIso` is a
 * commit's date, a datum about something else, and renaming it `now` would be wrong.
 */
const CURRENTNESS_WORDS = new Set(["current", "wall", "today", "present"]);
/**
 * Words that turn a time word into a MEASUREMENT of time rather than an instant. Without
 * these the ratchet would carry `nowPct` (a timeline marker's x-position) and `epoch` (a
 * cache generation) as if they were misspelled clocks.
 */
const NOT_AN_INSTANT = new Set([
  "pct",
  "percent",
  "ratio",
  "budget",
  "timeout",
  "duration",
  "interval",
  "elapsed",
  "age",
  "ago",
  "limit",
  "count",
  "index",
  "offset",
  "width",
  "max",
  "min",
  "generation",
  "zone",
  "format",
  "label",
  "range",
  "span",
  "delta",
  "diff",
]);

const SANCTIONED = new Set(["now: string", "nowMs: number"]);

/**
 * Non-canonical spellings, `<spelling>` → count. Only ever lower these.
 *
 * The total went from 74 to 80 when #721 replaced the six-name regex with the tiers above —
 * not because anything regressed, but because the predicate now sees spellings that were
 * never in the name list: `endNow: string` (4, session-lifecycle's exit context) and
 * `nowFn: () => number` (2, agent-cli-version). That is the whole point of the change.
 */
const BASELINE: Record<string, number> = {
  "now: Date": 32,
  "now: number": 15,
  "nowIso: string": 9,
  // 6 -> 5: one grandfathered `nowOverride` went away with this session's server-test
  // typecheck work. Banked because the ring is a ceiling, not a budget — a count left
  // above the live one is exactly the staleness the second assertion exists to catch.
  "nowOverride: string": 5,
  "now: () => Date": 4,
  "now: () => number": 4,
  "endNow: string": 4,
  "nowFn: () => number": 2,
  "nowMs: () => number": 2,
};

/** #583 — the tree walk every guard suite needs, from the one shared helper. */
const sourceFiles = (rel: string): string[] => walkPackageSources(path.join(packagesRoot, rel));

/** `currentTimeMs` → `["current","time","ms"]`. */
const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/** The normalised type text, or `null` when this declaration cannot be carrying a clock value. */
function timeTypeOf(type: ts.TypeNode | undefined, text: string): string | null {
  if (!type) return null;
  const normalised = text.slice(type.pos, type.end).trim().replace(/\s+/g, " ");
  return TIME_TYPES.has(normalised) ? normalised : null;
}

/** `Date.now()`, `new Date(…)`, `new Date().toISOString()` — a read of the wall clock. */
function readsTheClock(node: ts.Node): boolean {
  let hit = false;
  forEachNode(node, (child) => {
    if (ts.isNewExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "Date") hit = true;
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.name.text === "now"
    ) {
      hit = true;
    }
  });
  return hit;
}

/**
 * Names that this file coalesces with a clock read — `p ?? Date.now()`, `p || new Date()`,
 * `p ? new Date(p) : new Date()`. Tier 3, and the only tier that owes nothing to the name.
 */
function clockFallbackNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  forEachNode(sf, (node) => {
    if (ts.isBinaryExpression(node)) {
      const coalescing =
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken;
      const left = unwrapExpression(node.left);
      if (coalescing && ts.isIdentifier(left) && readsTheClock(node.right)) names.add(left.text);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = unwrapExpression(node.condition);
      if (ts.isIdentifier(condition) && (readsTheClock(node.whenTrue) || readsTheClock(node.whenFalse))) {
        names.add(condition.text);
      }
    }
  });
  return names;
}

interface Declaration {
  name: string;
  type: string;
  /** Optional or defaulted — the shape of an override rather than of a datum. */
  overrideShaped: boolean;
  /** Its own default reads the clock, or the file coalesces it with one. */
  clockFallback: boolean;
}

/** Every parameter and object-type property in this file that could be carrying a clock value. */
function timeTypedDeclarations(sf: ts.SourceFile, text: string): Declaration[] {
  const fallbacks = clockFallbackNames(sf);
  const found: Declaration[] = [];
  forEachNode(sf, (node) => {
    let name: string | null = null;
    let type: ts.TypeNode | undefined;
    let overrideShaped = false;
    let clockFallback = false;
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
      type = node.type;
      overrideShaped = node.questionToken !== undefined || node.initializer !== undefined;
      clockFallback = node.initializer !== undefined && readsTheClock(node.initializer);
    } else if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      name = node.name.text;
      type = node.type;
      overrideShaped = node.questionToken !== undefined;
      clockFallback = ts.isPropertyDeclaration(node) && node.initializer !== undefined && readsTheClock(node.initializer);
    }
    if (name === null) return;
    const timeType = timeTypeOf(type, text);
    if (timeType === null) return;
    found.push({ name, type: timeType, overrideShaped, clockFallback: clockFallback || fallbacks.has(name) });
  });
  return found;
}

/** Is this declaration an INJECTION POINT for the current time? The three tiers, in order. */
function isInjectedTime(decl: Declaration): boolean {
  const words = wordsOf(decl.name);
  if (words.some((word) => NOT_AN_INSTANT.has(word))) return false;
  // 1. a word that means "an instant" and nothing else.
  if (words.some((word) => STRONG_WORDS.has(word)) || /^as(of|at)/i.test(decl.name)) return true;
  // 2. a weak time word, made specific by an anchor or by the override shape.
  if (words.some((word) => WEAK_WORDS.has(word))) {
    if (words.some((word) => CURRENTNESS_WORDS.has(word))) return true;
    if (decl.overrideShaped) return true;
  }
  // 3. no name evidence at all — but it defaults to, or falls back on, a clock read.
  return decl.clockFallback;
}

function spellingCensus(): { all: number; nonCanonical: Record<string, number> } {
  const nonCanonical: Record<string, number> = {};
  let all = 0;
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, "utf8");
      for (const decl of timeTypedDeclarations(parseGuardSource(file, text), text)) {
        if (!isInjectedTime(decl)) continue;
        all += 1;
        const spelling = `${decl.name}: ${decl.type}`;
        if (SANCTIONED.has(spelling)) continue;
        nonCanonical[spelling] = (nonCanonical[spelling] ?? 0) + 1;
      }
    }
  }
  return { all, nonCanonical };
}

describe("injected-time parameter spelling is ratcheted (#614, #721)", () => {
  const { all, nonCanonical } = spellingCensus();

  it("finds now-parameters at all, so the ratchet cannot pass vacuously", () => {
    // The sanctioned pair alone is >100 declarations; if this scan ever returns nothing
    // the predicate has broken, not the codebase.
    expect(all).toBeGreaterThan(100);
  });

  it("no NEW spelling of an injected clock, and no existing one grows", () => {
    const { over, stale } = compareRatchet(BASELINE, nonCanonical);
    expect(
      over,
      [
        "Use `now?: string` (ISO, persisted) or `nowMs?: number` (epoch ms, arithmetic).",
        "A name this list has never seen still fails here — the gate matches the SHAPE of an",
        "injection point, not a fixed set of names (#721).",
        "",
        ...over,
      ].join("\n"),
    ).toEqual([]);

    // The other direction, so the baseline stays a ceiling instead of becoming a budget.
    expect(stale, ["The ratchet only tightens — lower or delete these:", ...stale].join("\n")).toEqual([]);
  });
});

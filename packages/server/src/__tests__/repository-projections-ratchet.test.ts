// @gate:always-run — recursively walks the repositories tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  parseGuardSource,
  forEachNode,
  lineOf,
  calleeName,
  compareRatchet,
} from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * The repository layer's shared projections are a DOWN-only ring (#732).
 *
 * #732 named the repository layer as the second duplication cluster. Re-measured here with
 * token-windowed clone detection, the largest clone runs between repository files were the
 * `select({...})` PROJECTIONS, not the query logic: the same column lists re-spelled per
 * accessor, per table. `repositories/projections.ts` declares them once.
 *
 * This suite is the disclosure channel that keeps the win (CLAUDE.md, #691). It enforces two
 * properties a one-off refactor commit cannot:
 *
 *   1. **Every shared projection has at least two real production callers.** #591 landed a
 *      shared helper with zero non-test callers and is remembered as a failure; a projection
 *      that drops to one caller should be inlined back, not left standing as evidence of an
 *      extraction that did not happen.
 *   2. **No raw re-spelling comes back.** The column sets the extraction removed are frozen
 *      at ZERO outside `projections.ts`, so pasting a sibling accessor's projection fails
 *      here instead of quietly restoring the duplication.
 *
 * ## Why the re-spelling check compares MEMBER SETS and not consecutive lines (#794)
 *
 * It used to compare a run of consecutive trimmed LINES, which made a duplicate projection
 * a duplicate only if it was printed exactly the way the original had been. Reordering the
 * columns, putting two on one line, or interleaving a fourth defeated it completely — and
 * none of those is a different projection, which is the whole point of the rule. An
 * `ObjectLiteralExpression`'s members are a SET regardless of print order, so the check is
 * now about what the projection IS rather than how it was typed. Comments are not members
 * either, so a comment quoting the forbidden columns no longer counts as an instance.
 */
const repositoriesDir = path.join(import.meta.dirname!, "..", "repositories");
const PROJECTIONS_FILE = "projections.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(repositoriesDir, f).split(path.sep).join("/");
const files = walk(repositoriesDir);
const readCache = new Map<string, string>();
const read = (f: string) => {
  let cached = readCache.get(f);
  if (cached === undefined) readCache.set(f, (cached = fs.readFileSync(f, "utf8")));
  return cached;
};

/** The projections `projections.ts` exports, and the minimum callers each must keep. */
const SHARED_PROJECTIONS = [
  "issueIdentityColumns",
  "issueTextColumns",
  "issueTriageColumns",
  "sessionLifecycleColumns",
  "issueDependencyColumns",
  "projectStatusIdName",
  "preferenceKeyValueColumns",
];

/**
 * The exact column SETS the extraction removed, as `name: source` members. An object literal
 * containing all of a set's members re-spells that projection, whatever its print order.
 * Frozen at zero occurrences OUTSIDE `projections.ts` — this is the ratchet, not a style
 * preference.
 */
const REMOVED_MEMBER_SETS: Record<string, string[]> = {
  issueIdentityColumns: ["id: issues.id", "issueNumber: issues.issueNumber", "title: issues.title"],
  sessionLifecycleColumns: [
    "id: sessions.id",
    "workspaceId: sessions.workspaceId",
    "status: sessions.status",
    "startedAt: sessions.startedAt",
    "endedAt: sessions.endedAt",
  ],
  issueDependencyColumns: [
    "id: issueDependencies.id",
    "issueId: issueDependencies.issueId",
    "dependsOnId: issueDependencies.dependsOnId",
    "type: issueDependencies.type",
  ],
};

/**
 * PRE-EXISTING re-spellings that the consecutive-LINE comparison could not see, frozen at
 * their current count and shrink-only. #779 warned an AST conversion surfaces what the text
 * version was blind to and that the finding is to be DISCLOSED, not fixed under a guard
 * ticket — this is that disclosure, and it is also the measurement of how much the old check
 * was worth: it reported zero while fourteen live projections re-spelled a shared one.
 *
 * Every one of them is a superset or a reordering — e.g. `dependency-auto-chain` selects
 * `{id, title, issueNumber, projectId, …}` (identity columns, reordered, plus two more) and
 * `autodrive-stall-warning` selects the five session-lifecycle columns with `workspaceId`
 * first. Neither is a different projection; both simply were not printed the way the
 * extraction had printed the original. Each is fixed by spreading the shared constant
 * (`.select({ ...issueIdentityColumns, projectId: issues.projectId, … })`), which is a
 * repository-layer change, not a guard change — so it belongs to whoever next touches the
 * file. Lower the entry when you do.
 */
const RESPELLING_BASELINE: Record<string, number> = {
  "autodrive-stall-warning.repository.ts::sessionLifecycleColumns": 1,
  "dependency-auto-chain.repository.ts::issueIdentityColumns": 1,
  "issue/cli-commands.repository.ts::issueIdentityColumns": 1,
  "issue-ai.repository.ts::issueIdentityColumns": 2,
  "placement-observability.repository.ts::issueIdentityColumns": 1,
  "project-activity.repository.ts::sessionLifecycleColumns": 1,
  "scheduled-run-query.repository.ts::issueIdentityColumns": 1,
  "session/analytics.ts::sessionLifecycleColumns": 1,
  "showdown.repository.ts::issueIdentityColumns": 1,
  "voice-capture.repository.ts::issueIdentityColumns": 1,
  "workspace-launch-failures.repository.ts::issueIdentityColumns": 1,
  "workspace-risk.repository.ts::issueIdentityColumns": 1,
};

/** One-line projections that were spelled inline, as the EXACT member set of a `.select({…})`. */
const REMOVED_INLINE_SELECTS: Record<string, string[]> = {
  projectStatusIdName: ["id: projectStatuses.id", "name: projectStatuses.name"],
  preferenceKeyValueColumns: ["key: preferences.key", "value: preferences.value"],
};

/** `name: initializer` for each member of an object literal, whitespace-normalised. */
function memberSet(object: ts.ObjectLiteralExpression, sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) {
      out.add(`${member.name.text}: ${member.initializer.getText(sf).replace(/\s+/g, " ")}`);
    } else if (ts.isShorthandPropertyAssignment(member)) {
      out.add(`${member.name.text}: ${member.name.text}`);
    }
  }
  return out;
}

export interface ProjectionHit {
  name: string;
  line: number;
}

/**
 * Object literals that re-spell one of the removed projections. Exported so the proof cases
 * below drive the REAL scanner rather than a copy of its predicate.
 */
export function scanRespelledProjections(cacheKey: string, text: string): ProjectionHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: ProjectionHit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const members = memberSet(node, sf);
    for (const [name, wanted] of Object.entries(REMOVED_MEMBER_SETS)) {
      if (wanted.every((m) => members.has(m))) hits.push({ name, line: lineOf(sf, node) });
    }
  });
  return hits;
}

/** `.select({…})` calls whose member set IS one of the removed inline projections. */
export function scanRespelledInlineSelects(cacheKey: string, text: string): ProjectionHit[] {
  const sf = parseGuardSource(cacheKey, text);
  const hits: ProjectionHit[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isCallExpression(node) || calleeName(node) !== "select") return;
    const argument = node.arguments[0];
    if (!argument || !ts.isObjectLiteralExpression(argument)) return;
    const members = memberSet(argument, sf);
    for (const [name, wanted] of Object.entries(REMOVED_INLINE_SELECTS)) {
      if (members.size === wanted.length && wanted.every((m) => members.has(m))) {
        hits.push({ name, line: lineOf(sf, node) });
      }
    }
  });
  return hits;
}

describe("repository projections (#732)", () => {
  it("the scan reaches the repositories tree and finds projections.ts", () => {
    // A path typo would make every assertion below vacuously green.
    expect(files.length).toBeGreaterThan(80);
    expect(files.map(rel)).toContain(PROJECTIONS_FILE);
  });

  it("every shared projection is exported from projections.ts", () => {
    const source = read(path.join(repositoriesDir, PROJECTIONS_FILE));
    const missing = SHARED_PROJECTIONS.filter((n) => !new RegExp(`^export const ${n}\\b`, "m").test(source));
    expect(missing, `not exported — rename here too:\n${missing.join("\n")}`).toEqual([]);
  });

  it("no shared projection has fewer than two production callers (#591)", () => {
    const consumers = files.filter((f) => rel(f) !== PROJECTIONS_FILE);
    const thin = SHARED_PROJECTIONS.map((name) => {
      const callers = consumers.filter((f) => new RegExp(`\\b${name}\\b`).test(read(f))).map(rel);
      return { name, callers };
    }).filter((p) => p.callers.length < 2);
    expect(
      thin,
      "A shared projection with fewer than two callers is the #591 failure mode — inline it\n" +
        "back into its one caller rather than leaving a helper nobody shares:\n" +
        thin.map((p) => `${p.name}: ${p.callers.length} caller(s) [${p.callers.join(", ")}]`).join("\n"),
    ).toEqual([]);
  });

  const respellingCounts = (): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const file of files) {
      if (rel(file) === PROJECTIONS_FILE) continue;
      for (const h of scanRespelledProjections(file, read(file))) {
        const id = `${rel(file)}::${h.name}`;
        counts[id] = (counts[id] ?? 0) + 1;
      }
    }
    return counts;
  };

  it("no removed column set is re-spelled outside projections.ts, beyond the baseline", () => {
    const { over } = compareRatchet(RESPELLING_BASELINE, respellingCounts());
    expect(
      over,
      "Spread the shared projection instead of re-listing its columns:\n" +
        "  .select({ ...issueIdentityColumns, statusName: projectStatuses.name })\n" +
        over.join("\n"),
    ).toEqual([]);
  });

  it("the re-spelling baseline is not stale — lower it as each is spread (#794)", () => {
    const { stale } = compareRatchet(RESPELLING_BASELINE, respellingCounts());
    expect(stale, `Nice — lower or delete these entries:\n${stale.join("\n")}`).toEqual([]);
  });

  it("no removed inline projection is re-spelled outside projections.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file) === PROJECTIONS_FILE) continue;
      for (const h of scanRespelledInlineSelects(file, read(file))) {
        offenders.push(`${rel(file)}:${h.line} re-spells ${h.name}`);
      }
    }
    expect(offenders, `use .select(${"<the shared constant>"}):\n${offenders.join("\n")}`).toEqual([]);
  });

  /**
   * The other half of #732's repository work: SIX repositories declared the byte-identical
   * `{id, name}` status list under six different names, and the copies had already drifted
   * (one ordered by `sortOrder`, five did not). One implementation now; the six old names
   * are one-line delegations.
   */
  it("the project-status id/name query is spelled in exactly one place", () => {
    const query = ".from(projectStatuses)";
    const marker = ".select(projectStatusIdName)";
    const spellers = files.filter((f) => {
      const t = read(f);
      return t.includes(marker) && t.includes(query);
    }).map(rel);
    expect(
      spellers.sort(),
      "call listProjectStatusIdNames() instead of re-spelling the query. The one accepted\n" +
        "extra site reads inside a transaction, which the accessor's `database: Database`\n" +
        "seam cannot take (#604):\n" + spellers.join("\n"),
    ).toEqual(["backlog-snapshot.repository.ts", "project-status.repository.ts"]);
  });
});

/**
 * #779's proof obligation (#794): the conversion must catch the forms the consecutive-line
 * comparison could not see, and still catch the one it did.
 */
describe("the projection scan compares member SETS, not line runs (#794)", () => {
  const scan = (name: string, lines: string[]) =>
    scanRespelledProjections(`/virtual/projections/${name}.ts`, lines.join("\n"));
  const scanSelect = (name: string, lines: string[]) =>
    scanRespelledInlineSelects(`/virtual/projections-select/${name}.ts`, lines.join("\n"));

  it("still catches the verbatim run the line comparison caught", () => {
    const hits = scan("verbatim", [
      "const q = db.select({",
      "  id: issues.id,",
      "  issueNumber: issues.issueNumber,",
      "  title: issues.title,",
      "});",
    ]);
    expect(hits.map((h) => h.name)).toEqual(["issueIdentityColumns"]);
  });

  it("catches the same projection with the columns REORDERED", () => {
    // Reordering is not a different projection, but it broke the consecutive-line match
    // completely — so the cheapest possible edit restored the duplication invisibly.
    const hits = scan("reordered", [
      "const q = db.select({",
      "  title: issues.title,",
      "  id: issues.id,",
      "  issueNumber: issues.issueNumber,",
      "});",
    ]);
    expect(hits.map((h) => h.name)).toEqual(["issueIdentityColumns"]);
  });

  it("catches it with an unrelated column INTERLEAVED, and when two share a line", () => {
    expect(
      scan("interleaved", [
        "const q = db.select({",
        "  id: issues.id,",
        "  statusId: issues.statusId,",
        "  issueNumber: issues.issueNumber,",
        "  title: issues.title,",
        "});",
      ]).map((h) => h.name),
    ).toEqual(["issueIdentityColumns"]);
    expect(
      scan("packed", ["const q = db.select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title });"])
        .map((h) => h.name),
    ).toEqual(["issueIdentityColumns"]);
  });

  it("does not count a comment quoting the forbidden columns", () => {
    const hits = scan("prose", [
      "// Do not re-spell:",
      "//   id: issues.id,",
      "//   issueNumber: issues.issueNumber,",
      "//   title: issues.title,",
      "export const spreadInstead = 1;",
    ]);
    expect(hits).toEqual([]);
  });

  it("does not count a partial overlap, or a same-named column from another table", () => {
    expect(scan("partial", ["const q = db.select({ id: issues.id, title: issues.title });"])).toEqual([]);
    expect(
      scan("other-table", [
        "const q = db.select({ id: drafts.id, issueNumber: drafts.issueNumber, title: drafts.title });",
      ]),
    ).toEqual([]);
  });

  it("catches an inline .select projection that was re-wrapped across lines", () => {
    // The old check was a literal substring of the ONE-line form, so pressing Enter twice
    // was enough to reintroduce it.
    const hits = scanSelect("wrapped-inline", [
      "const rows = await db",
      "  .select({",
      "    key: preferences.key,",
      "    value: preferences.value,",
      "  })",
      "  .from(preferences);",
    ]);
    expect(hits.map((h) => h.name)).toEqual(["preferenceKeyValueColumns"]);
  });

  it("still leaves a .select that only OVERLAPS the inline projection alone", () => {
    expect(
      scanSelect("superset", [
        "const rows = await db.select({ key: preferences.key, value: preferences.value, id: preferences.id });",
      ]),
    ).toEqual([]);
  });
});

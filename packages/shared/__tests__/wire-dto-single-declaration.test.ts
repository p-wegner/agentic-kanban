// @gate:always-run — walks the client, server, mcp-server and shared source trees; imports nothing it checks.
/**
 * A wire DTO is declared ONCE (#569).
 *
 * `packages/shared/src/types/api.ts` opens by calling itself "the hand-authored WIRE
 * CONTRACT". It was not: 90 type names existed in BOTH the client and a server package
 * and in neither case in shared, and the pairs had drifted in exactly the ways two
 * hand-maintained copies drift — `staleness` required on one side and optional on the
 * other, `PreflightVerdict` a precise template-literal union on one side and `string` on
 * the other, `IssueComment.kind` widened to `string` on both although the repository has
 * had a six-member union all along.
 *
 * This is a RATCHET, not a ban. The remaining duplicates are grandfathered below and the
 * lists may only SHRINK: moving one into `shared/src/types/api/` and deleting the copies is
 * a one-line edit here. A NEW duplicate fails, which is the point — the drift was never
 * introduced deliberately, it accumulated one component at a time.
 *
 * A name that is genuinely local on both sides (a `Listener` in a client hook and an
 * unrelated `Listener` in a server service) belongs in GENUINELY_LOCAL, with a reason.
 *
 * ## #734 — the three ways the regex version could be dodged
 *
 * It matched `/^export (interface|type) (\w+)/gm` and compared NAME SETS between the client
 * and a server package. So:
 *
 *  1. **Renaming the copy was a total dodge.** The guard's whole subject is two
 *     hand-maintained copies of one shape drifting, and it recognised a copy only by its
 *     name — so `ProbeClientRow` / `ProbeServerRow`, byte-identical members, passed. #721
 *     verified that on the live tree. The structural half below is the actual invariant, and
 *     it immediately found **15** cross-package shape twins under different names that the
 *     name rule could never see.
 *  2. **Only client-vs-server/mcp was compared**, so a duplicate between `server` and
 *     `mcp-server`, or between `shared` and `server`, was invisible — and a name present in
 *     `shared` was *exempted* rather than being the worst case (three copies, not two).
 *     Comparing all four packages pairwise takes the name-duplicate count from 16 to 57.
 *  3. **`^export` required column 0**, so a declaration nested in a function, a namespace or
 *     a `declare module` block was never seen at all.
 *
 * All three are properties of scanning TEXT, and the shared typed guard layer (#721) already
 * exists, so this suite reads the AST: `parseGuardSource` + `forEachNode` find every
 * `interface`/`type` declaration at any nesting depth, exported or not.
 *
 * ## What the structural signature is, and what it deliberately cannot see
 *
 * A signature is the sorted `name?:typeText` list of an interface's (or type-literal alias's)
 * property members — so member ORDER and declaration formatting do not matter, but the member
 * TYPE is compared as normalised source text. `string | null` and `null | string` are
 * therefore different shapes, and a shape whose members are not plain properties (index
 * signatures, call/construct signatures, methods) gets no signature at all. That is a
 * heuristic net rather than a type checker: it closes the rename dodge, which is what #734
 * asks for, without the cost of a real `ts.Program` in a suite that runs on every merge.
 *
 * Shapes with fewer than {@link MIN_STRUCTURAL_MEMBERS} members are also skipped — at two
 * members, coincidence (`{ id: string; name: string }`) outnumbers copying, and a guard that
 * cries wolf earns a blanket exemption list instead of fixes.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import ts from "typescript";
import { walkPackageSources, parseGuardSource, lineOf, forEachNode } from "./helpers/guard-scan.js";
import { fileURLToPath } from "node:url";

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every package whose declarations take part. Compared PAIRWISE, unlike the #569 version. */
const PACKAGES = ["client", "server", "mcp-server", "shared"];

/** Below this, an identical member list is more likely coincidence than a copy. */
const MIN_STRUCTURAL_MEMBERS = 3;

/** Same name on both sides, but two unrelated concepts — moving them would be wrong. */
const GENUINELY_LOCAL: Record<string, string> = {
  Listener: "a client SSE listener and a server port listener — unrelated concepts",
};

/**
 * Grandfathered duplicate NAMES — a name declared in two or more of {@link PACKAGES}.
 * MAY ONLY SHRINK.
 *
 * Batch 1 (#569) removed the agent-questions family, OrchestratorStatus, the scorecard
 * pair, IssueComment + IssueCommentKind and the preflight family: 75 -> 62. #734 re-pinned
 * the list against the AST predicate and all four packages pairwise, which is why it grew
 * from 16 to 57: **the number went UP because the rule got stricter**, not because anything
 * regressed. Every entry beyond the original 16 was already duplicated at that commit and
 * simply outside what a client-vs-server name comparison could see.
 */
const GRANDFATHERED = new Set<string>([
  "AgentProvider",
  "ButlerEvent",
  "CacheEntry",
  "CodemodFileDiff",
  "ConductorSchedule",
  "ContractIssueRow",
  "CouplingSuggestion",
  "CreateFlakyTestRequest",
  "DbOrTx",
  "DependencyType",
  "DriveStatus",
  "EnableReport",
  "FalseFlakeTelemetry",
  "FileContentionResult",
  "FinalOutcome",
  "FlakeDecision",
  "FlakyTestEntry",
  "ImportFormat",
  "ImportResult",
  "InsightsData",
  "InsightsRange",
  "InvalidationListener",
  "IssueCommentKind",
  "LaunchFailureCategory",
  "LoopAdvanceResult",
  "LoopStall",
  "MainWorkspaceInfo",
  "MarketplaceEntry",
  "MilestoneSummary",
  "MonitorCycleSummary",
  "MonitorTunables",
  "OnboardingState",
  "ParsedLine",
  "PreviewRow",
  "Project",
  "RepoMergeStatusEntry",
  "RepoMergeStatusResponse",
  "Route",
  "RunbookContent",
  "SessionResult",
  "Settings",
  "SkippedRow",
  "SlowRequestEntry",
  "StartMode",
  "StartPolicy",
  "StatusRow",
  "TagRow",
  "VoiceCaptureResult",
  "WarningRow",
  "WorkerRow",
  "WorkspaceInfo",
  "WorkspaceLaunchFailure",
  "WorkspaceLaunchFailuresResponse",
  "WorkspaceRow",
  "WorkspaceStatus",
]);

/**
 * Grandfathered STRUCTURAL duplicates: one wire shape declared under DIFFERENT names in more
 * than one package. MAY ONLY SHRINK.
 *
 * These are the dodge the name rule could not see, and #721 verified the dodge worked. Each
 * key is the group's `pkg:Name` members, sorted and joined — stable under reformatting and
 * under moving a declaration within its package, and it changes when the group's MEMBERSHIP
 * changes, which is exactly when a human should look again.
 */
const GRANDFATHERED_STRUCTURAL = new Set<string>([
  "client:BurndownData|server:BurndownResult",
  "client:ConflictPreview|server:WorkspaceConflictPreview",
  "client:CycleTimeData|server:CycleTimeResult",
  "client:Dependency|server:DependencyRow",
  "client:MilestoneBurndownPoint|shared:BurndownBucket",
  "client:PluginGateAction|shared:PluginLoopGateAction",
  "client:ProjectTag|client:QuickUpdateTag|client:Tag|client:TagBadge|server:BoardIssueTag|server:TagRow",
  "client:ProviderDivergence|client:ProviderDivergence|shared:ProviderDivergenceResult",
  "client:ProviderEntry|server:ProviderThroughput",
  "client:SkillRunResult|server:PluginSkillRunResult",
  "client:StatusRow|shared:StatusOrderRow",
  "server:AgentOutputEvent|shared:WorkerAgentEvent",
  "server:FlakyTestResponse|shared:FlakyTestEntry",
  "server:RetryDecisionResponse|shared:RetryDecision",
  "server:RottedSuite|shared:RottedSuiteEntry",
]);

interface Declaration {
  pkg: string;
  name: string;
  /** `null` when the shape is not a plain property bag — see the header. */
  signature: string | null;
  where: string;
}

/**
 * The sorted `name?:type` list of a property bag, or `null` for anything else. Member types
 * are normalised source text: enough to catch a copy, not a substitute for a type checker.
 */
function memberSignature(members: readonly ts.TypeElement[], sf: ts.SourceFile): string | null {
  if (members.length < MIN_STRUCTURAL_MEMBERS) return null;
  const parts: string[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name) return null;
    const key = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
    if (key === null) return null;
    const type = member.type ? member.type.getText(sf).replace(/\s+/g, " ").trim() : "any";
    parts.push(`${key}${member.questionToken ? "?" : ""}:${type}`);
  }
  return parts.sort().join(";");
}

/**
 * Every `interface`/`type` declaration in a package, at ANY nesting depth — `forEachNode`
 * rather than a `^export` regex, which is what drops #734's column-0 requirement. Exported
 * and non-exported alike: a local copy of a wire shape drifts just as freely as an exported
 * one, and the `Listener` case shows the guard already had to reason about local names.
 */
function declarationsOf(pkg: string): Declaration[] {
  const out: Declaration[] = [];
  for (const file of walkPackageSources(path.join(packagesRoot, pkg, "src"))) {
    const sf = parseGuardSource(file);
    const rel = path.relative(packagesRoot, file).split(path.sep).join("/");
    forEachNode(sf, (node) => {
      if (ts.isInterfaceDeclaration(node)) {
        out.push({ pkg, name: node.name.text, signature: memberSignature(node.members, sf), where: `${rel}:${lineOf(sf, node)}` });
        return;
      }
      if (ts.isTypeAliasDeclaration(node)) {
        const signature = ts.isTypeLiteralNode(node.type) ? memberSignature(node.type.members, sf) : null;
        out.push({ pkg, name: node.name.text, signature, where: `${rel}:${lineOf(sf, node)}` });
      }
    });
  }
  return out;
}

/** `pkg:Name|pkg:Name` — the stable identity of a structural-duplicate group. */
const structuralKey = (group: Declaration[]): string =>
  group
    .map((d) => `${d.pkg}:${d.name}`)
    .sort()
    .join("|");

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k) ?? [];
    arr.push(item);
    map.set(k, arr);
  }
  return map;
}

describe("wire DTOs are declared once (#569)", () => {
  const all = PACKAGES.flatMap(declarationsOf);

  /** A name declared in more than one package. */
  const duplicatedNames = [...groupBy(all, (d) => d.name)]
    .filter(([, ds]) => new Set(ds.map((d) => d.pkg)).size > 1)
    .map(([name]) => name)
    .filter((name) => !(name in GENUINELY_LOCAL))
    .sort();

  /** One shape, more than one package, and more than one NAME — the rename dodge. */
  const structuralGroups = [...groupBy(all.filter((d) => d.signature !== null), (d) => d.signature!)]
    .map(([, ds]) => ds)
    .filter((ds) => new Set(ds.map((d) => d.pkg)).size > 1 && new Set(ds.map((d) => d.name)).size > 1);

  it("sees declarations at all, in every package, nested ones included", () => {
    // The scan IS the guard. If the walk broke, every list below would be empty and every
    // assertion would pass — the failure mode a name-set comparison cannot tell from success.
    expect(all.length).toBeGreaterThan(1500);
    for (const pkg of PACKAGES) expect(all.some((d) => d.pkg === pkg), `no declarations found in ${pkg}`).toBe(true);
    expect(all.filter((d) => d.signature !== null).length).toBeGreaterThan(200);
  });

  it("no NEW type name is declared in more than one package", () => {
    const fresh = duplicatedNames.filter((n) => !GRANDFATHERED.has(n));
    const why = [
      "These names are declared in two or more of client/server/mcp-server/shared.",
      "Two hand-maintained copies of one wire shape drift - that is what this guard exists to stop.",
      "Move the type into packages/shared/src/types/api/ and import it on both sides, or add it",
      "to GENUINELY_LOCAL with the reason it is not the same concept:",
      ...fresh.map((n) => `  ${n}  (${all.filter((d) => d.name === n).map((d) => d.where).join(", ")})`),
    ].join("\n");
    expect(fresh, why).toEqual([]);
  });

  it("the grandfathered name list only shrinks - remove entries as they are moved", () => {
    const stale = [...GRANDFATHERED].filter((n) => !duplicatedNames.includes(n)).sort();
    const why = [
      "These are listed as grandfathered duplicates but are no longer duplicated.",
      "Delete them from GRANDFATHERED so the ratchet keeps its teeth:",
      ...stale.map((n) => `  ${n}`),
    ].join("\n");
    expect(stale, why).toEqual([]);
  });

  it("no NEW wire shape is duplicated under a different name (#734 — the rename dodge)", () => {
    const fresh = structuralGroups
      .map(structuralKey)
      .filter((key) => !GRANDFATHERED_STRUCTURAL.has(key))
      .sort();
    const why = [
      "These declarations have IDENTICAL member lists in more than one package under DIFFERENT",
      "names, which is the dodge the name-equality rule could not see: rename the copy and the",
      "guard went quiet while the two shapes went on drifting. Move the shape into",
      "packages/shared/src/types/api/ and import it on both sides.",
      "",
      ...structuralGroups
        .filter((g) => fresh.includes(structuralKey(g)))
        .map((g) => `  ${g.map((d) => `${d.pkg}:${d.name} (${d.where})`).join("  ==  ")}`),
    ].join("\n");
    expect(fresh, why).toEqual([]);
  });

  it("the grandfathered structural list only shrinks", () => {
    const live = new Set(structuralGroups.map(structuralKey));
    const stale = [...GRANDFATHERED_STRUCTURAL].filter((key) => !live.has(key)).sort();
    const why = [
      "These structural duplicate groups no longer exist, or their membership changed (the key is",
      "the group's sorted pkg:Name list, so it moves when a member is added, removed or renamed).",
      "Re-check the group and update or delete the entry:",
      ...stale.map((k) => `  ${k}`),
    ].join("\n");
    expect(stale, why).toEqual([]);
  });

  it("GENUINELY_LOCAL entries are live and reasoned — a dead exemption excuses the next name", () => {
    const names = new Set(all.map((d) => d.name));
    for (const [name, reason] of Object.entries(GENUINELY_LOCAL)) {
      expect(names.has(name), `GENUINELY_LOCAL names ${name}, which nothing declares any more`).toBe(true);
      expect(reason.trim().length, `GENUINELY_LOCAL[${name}] needs a reason, not a placeholder`).toBeGreaterThan(15);
    }
  });
});

/**
 * Ticket-sizing floor for the epic splitter (#116). Pure, DB/LLM-free logic that keeps a
 * test in the same vertical slice as the code it covers and detects an over-split that
 * shouldn't have happened. Extracted from `issue-ai.service.ts` (god-module ceiling) — the
 * splitter's deterministic backstop lives here and is unit-tested directly
 * (`decompose-ticket-sizing-floor.test.ts`).
 *
 * Why it exists: the board-tuning-lab measured that decomposing along too-fine seams costs
 * ~3-5x the tokens to deliver the same feature — each micro-ticket re-pays a fixed cost
 * (fresh worktree, agent re-orienting, re-running tests, a separate commit). The observed
 * failure was decomposing an atomic "add GET /api/version" ticket into ["add the route",
 * "add a test for the route"] — two workspaces for one line.
 */
import type { DependencyType } from "@agentic-kanban/shared/schema";

export interface DecomposeChildProposal {
  tempId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  /** Repo-aware decomposition (#94): the repo this child should target in a multi-repo
   *  project, carried onto the child as a `repo:<name>` tag on confirm. Omitted/undefined
   *  for single-repo projects and children the AI didn't scope. Editable pre-confirm. */
  targetRepo?: string | null;
}

export interface DecomposeDependencyProposal {
  fromTempId: string;
  toTempId: string;
  type: DependencyType;
}

/** A child ticket whose ONLY job is to add tests for a sibling's code — no production code
 *  of its own. Splitting it into a separate ticket forces a second workspace (bootstrap +
 *  orientation + a serialized depends_on wait) for zero parallelism, because the test can't
 *  even start until the code ticket merges. The heuristic is deliberately conservative: the
 *  child must depend_on exactly one sibling (its implementation) AND read as pure test-adding
 *  work — so a genuine "build the integration-test harness" epic child (no such dependency)
 *  and a code+test child ("Implement validateTag and its tests") are both left alone. #116. */
export function isTestOnlyChild(
  child: DecomposeChildProposal,
  dependsOnTargets: string[],
): boolean {
  // Must be a straight follow-on to exactly one implementation sibling — not a standalone
  // "build the test harness" epic (which has no such dependency) and not a code+test child.
  if (dependsOnTargets.length !== 1) return false;
  const title = child.title.toLowerCase().trim();
  // A pure test-adding verb (NOT "implement", which builds code) …
  if (!/^(add|write|create)\b/.test(title)) return false;
  // … whose head (first few words) is the test/spec itself — so "Add tests for X" matches
  // but "Add POST /api/x route" or "Implement validateTag and its tests" does not. `\b`
  // avoids matching "latest"/"contest" while still catching "node:test".
  const head = title.split(/\s+/).slice(0, 4).join(" ");
  return /\btest|\bspec/.test(head);
}

/** Post-process a decompose proposal to keep tests with their implementation and to detect
 *  an over-split that shouldn't have happened. Pure (no DB / no LLM) so it is unit-tested
 *  directly and can't drift. For each test-only child (see {@link isTestOnlyChild}) it folds
 *  a note into the implementation sibling it depended on, drops the child, and rewires any
 *  edges that pointed at the dropped child onto its implementation target. Then, if the
 *  surviving real children number <=1, flags `tooSmallToDecompose` — the epic was already
 *  single-session-sized. #116. */
export function coalesceTestOnlyChildren(
  children: DecomposeChildProposal[],
  dependencies: DecomposeDependencyProposal[],
): {
  children: DecomposeChildProposal[];
  dependencies: DecomposeDependencyProposal[];
  coalescedTestOnly: string[];
  tooSmallToDecompose: boolean;
} {
  // depends_on targets per child (the sibling(s) this child needs finished first).
  const dependsOnTargets = new Map<string, string[]>();
  for (const d of dependencies) {
    if (d.type !== "depends_on") continue;
    const arr = dependsOnTargets.get(d.fromTempId) ?? [];
    arr.push(d.toTempId);
    dependsOnTargets.set(d.fromTempId, arr);
  }

  const byId = new Map(children.map((c) => [c.tempId, c]));
  // absorbInto: dropped test-only child tempId -> implementation sibling tempId it merges into.
  const absorbInto = new Map<string, string>();
  for (const child of children) {
    const targets = dependsOnTargets.get(child.tempId) ?? [];
    if (isTestOnlyChild(child, targets) && byId.has(targets[0]) && targets[0] !== child.tempId) {
      absorbInto.set(child.tempId, targets[0]);
    }
  }

  if (absorbInto.size === 0) {
    return {
      children,
      dependencies,
      coalescedTestOnly: [],
      tooSmallToDecompose: children.length <= 1,
    };
  }

  // Fold each dropped child's intent into its implementation sibling's description.
  const survivors = children
    .filter((c) => !absorbInto.has(c.tempId))
    .map((c) => {
      const absorbed = children.filter((x) => absorbInto.get(x.tempId) === c.tempId);
      if (absorbed.length === 0) return c;
      const note = absorbed.map((a) => a.title.trim()).join("; ");
      return { ...c, description: `${c.description}\n\nInclude tests in this ticket: ${note}.`.trim() };
    });

  // Drop edges touching a coalesced child; rewire ones that pointed AT it onto its target.
  const rewired: DecomposeDependencyProposal[] = [];
  for (const d of dependencies) {
    if (absorbInto.has(d.fromTempId)) continue; // the test child is gone; its own deps vanish
    if (absorbInto.has(d.toTempId)) {
      const target = absorbInto.get(d.toTempId)!;
      if (d.fromTempId !== target) rewired.push({ ...d, toTempId: target });
      continue;
    }
    rewired.push(d);
  }
  // De-dupe identical edges produced by rewiring.
  const seen = new Set<string>();
  const dedupedDeps = rewired.filter((d) => {
    const k = `${d.fromTempId}|${d.toTempId}|${d.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    children: survivors,
    dependencies: dedupedDeps,
    coalescedTestOnly: [...absorbInto.keys()],
    tooSmallToDecompose: survivors.length <= 1,
  };
}

/**
 * Pure view-model for the train detail drawer's bisect tree (#1189) — turns the flat
 * `attempts` list (`MergeTrainGateEvidenceDto.attempts`, appended one node per
 * `runTrainAttempt` as it finishes) into the tree the drawer renders: parent/child edges
 * derived from label prefixes, per-node gate duration, the path to each culprit (a `red`
 * leaf), total gate runs, and the sequential-cost counterfactual. Kept pure per
 * `lib/<feature>.ts` (#589) so the tree/duration/counterfactual math is testable without a
 * component.
 */

import type { MergeTrainAttemptDto, MergeTrainAttemptVerdict } from "@agentic-kanban/shared";

export type { MergeTrainAttemptDto, MergeTrainAttemptVerdict };

export interface BisectTreeNode {
  attempt: MergeTrainAttemptDto;
  /** Gate duration in ms, or null when no gate ran (`assembly_empty`) or timestamps are missing. */
  durationMs: number | null;
  /** True when this leaf's verdict blames the code itself (a real culprit), never env/refusal/empty. */
  isCulprit: boolean;
  children: BisectTreeNode[];
}

/**
 * Build the tree from the flat, order-of-finish attempt list. A child's label always extends
 * its parent's by exactly one letter (`q1` -> `q1a`/`q1b`), so the parent is found by dropping
 * the last character — no separate id/parent bookkeeping is persisted, because the label IS
 * the address. The root is the attempt with the shortest label (ties broken by first-seen);
 * an attempt whose computed parent label is absent from the set is treated as a second root
 * (defensive — should not happen against a real run, but a malformed/partial evidence blob
 * must render something rather than throwing).
 */
export function buildBisectTree(attempts: MergeTrainAttemptDto[]): BisectTreeNode[] {
  const byLabel = new Map<string, MergeTrainAttemptDto>();
  for (const a of attempts) byLabel.set(a.label, a);

  const nodeByLabel = new Map<string, BisectTreeNode>();
  for (const a of attempts) {
    nodeByLabel.set(a.label, {
      attempt: a,
      durationMs: computeDurationMs(a),
      isCulprit: a.verdict === "red",
      children: [],
    });
  }

  const roots: BisectTreeNode[] = [];
  // Sort by label length then alphabetically so children attach in the order a bisect would
  // discover them, independent of the arrival order `attempts` happens to carry.
  const sortedLabels = [...nodeByLabel.keys()].sort((x, y) => x.length - y.length || x.localeCompare(y));
  for (const label of sortedLabels) {
    const node = nodeByLabel.get(label)!;
    const parentLabel = label.slice(0, -1);
    const parent = parentLabel.length > 0 ? nodeByLabel.get(parentLabel) : undefined;
    if (parent && byLabel.has(parentLabel)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function computeDurationMs(attempt: MergeTrainAttemptDto): number | null {
  if (!attempt.gateStartedAt || !attempt.gateFinishedAt) return null;
  const start = new Date(attempt.gateStartedAt).getTime();
  const end = new Date(attempt.gateFinishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** Every root-to-leaf path whose leaf is an individually-proven-red culprit (never env/refused/empty). */
export function culpritPaths(roots: BisectTreeNode[]): BisectTreeNode[][] {
  const paths: BisectTreeNode[][] = [];
  function walk(node: BisectTreeNode, ancestry: BisectTreeNode[]) {
    const path = [...ancestry, node];
    if (node.children.length === 0) {
      if (node.isCulprit) paths.push(path);
      return;
    }
    for (const child of node.children) walk(child, path);
  }
  for (const root of roots) walk(root, []);
  return paths;
}

/** Set of every node id (by label) that sits on the path to a culprit — for highlighting. */
export function culpritPathLabels(roots: BisectTreeNode[]): Set<string> {
  const labels = new Set<string>();
  for (const path of culpritPaths(roots)) {
    for (const node of path) labels.add(node.attempt.label);
  }
  return labels;
}

export interface BisectTreeStats {
  totalGateRuns: number;
  totalGateDurationMs: number;
  /** Root nodes' summed gate duration — the SEQUENTIAL cost if each root ran on its own, one at a time. */
  sequentialCounterfactualMs: number;
  culpritCount: number;
  nodeCount: number;
}

/**
 * The counterfactual named in the ticket: what a per-member sequential gate would have cost
 * against the SAME member count, vs. what the train's bisect actually spent. A train that
 * never bisects (the happy path) costs exactly one gate run either way, so the delta is only
 * interesting once a bisect happened — computed from the member count of the root attempt
 * (the full batch) times its OWN duration, which is the best available per-gate cost estimate
 * without re-running anything.
 */
export function computeBisectTreeStats(roots: BisectTreeNode[]): BisectTreeStats {
  let totalGateRuns = 0;
  let totalGateDurationMs = 0;
  let nodeCount = 0;
  function walk(node: BisectTreeNode) {
    nodeCount += 1;
    totalGateRuns += node.attempt.gateRuns;
    totalGateDurationMs += node.durationMs ?? 0;
    for (const child of node.children) walk(child);
  }
  for (const root of roots) walk(root);

  // A culprit is a LEAF proven red — an internal red node was itself split further, so it is
  // the question a bisect asked, not the answer (`culpritPaths` is the same "leaf only" rule).
  const culpritCount = culpritPaths(roots).length;

  // Sequential counterfactual: each member gated on its own, at the root's per-gate cost
  // (the root attempt is the only node whose duration reflects gating the whole batch).
  const rootDurations = roots.map((r) => r.durationMs ?? 0);
  const memberCounts = roots.map((r) => r.attempt.members.length || 1);
  const perMemberCost = roots.map((_, i) => (rootDurations[i] ?? 0) / (memberCounts[i] ?? 1));
  const sequentialCounterfactualMs = roots.reduce(
    (sum, r, i) => sum + r.attempt.members.length * (perMemberCost[i] ?? 0),
    0,
  );

  return { totalGateRuns, totalGateDurationMs, sequentialCounterfactualMs, culpritCount, nodeCount };
}

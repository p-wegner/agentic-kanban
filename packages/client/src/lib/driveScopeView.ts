/**
 * Pure view logic for the Drive dashboard's tier-graph section (#1130).
 *
 * A drive planned from its target creates an epic and links it, but the epic gets no
 * children until it is decomposed — and `#1074`'s dashboard fallback makes a childless
 * epic scope ITSELF, so the dashboard reads as one tier of one issue exactly like a
 * genuinely decomposed one-ticket drive. Before this, the tier-graph section rendered
 * either the tier graph OR the decompose door based solely on `tiers.length === 0`, so
 * the moment the epic existed the door vanished — a permanent dead end if the decompose
 * modal was ever closed, errored, or simply not confirmed.
 *
 * `selfScoped` (reported by `buildDriveDashboard`) is what tells the two states apart.
 */
export interface DriveTierGraphViewState {
  /** Render the tier graph (there is at least one scoped issue). */
  showTierGraph: boolean;
  /** Render the empty-scope planner (no epic, or an epic with no children at all). */
  showEmptyScopePlanner: boolean;
  /**
   * Render the "planned but not decomposed" door ALONGSIDE the tier graph — distinct
   * from the empty-scope planner, which replaces the graph because there is nothing to
   * show yet.
   */
  showDecomposeDoor: boolean;
}

export function resolveDriveTierGraphView(
  tiersLength: number,
  selfScoped: boolean,
): DriveTierGraphViewState {
  const showTierGraph = tiersLength > 0;
  return {
    showTierGraph,
    showEmptyScopePlanner: !showTierGraph,
    showDecomposeDoor: showTierGraph && selfScoped,
  };
}

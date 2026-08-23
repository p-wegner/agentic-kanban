/**
 * Baseline for function-nloc-ratchet.test.ts (#763).
 *
 * Every client function whose own extent is >= LIST_THRESHOLD (400) non-blank, non-comment
 * lines, MEASURED on 2026-08-23 by the shared scanner (ten entries re-banked the same day, after #810's <Icon> adoption shortened their render) (packages/shared/__tests__/helpers/
 * function-nloc.ts, lifted out of that test file by #800). Nothing here was copied
 * from a metrics report — see the test's header for why that matters.
 *
 * Only ever LOWER a number or delete a line. The ratchet fails on growth, on a listed
 * function that has vanished, and on a number that has become stale.
 */
export const FUNCTION_NLOC_BASELINE: Record<string, number> = {
  "components/Layout.tsx::Layout": 708,
  "components/ButlerView.tsx::ButlerView": 693,
  "components/CreateWorkspaceForm.tsx::CreateWorkspaceForm": 694,
  "routes/BoardPage.tsx::BoardPage": 627,
  "components/WorkspaceCard.tsx::WorkspaceCard": 616,
  "components/BacklogView.tsx::BacklogView": 607,
  "components/IssueDetailPanel.tsx::IssueDetailPanel": 561,
  "components/PluginViewsPanel.tsx::PluginViewsPanel": 551,
  "components/GraphView.tsx::GraphView": 548,
  "hooks/useWorkspaceActions.ts::useWorkspaceActions": 524,
  "components/WorkflowBuilder.tsx::WorkflowBuilder": 516,
  "components/WorkspacePanel.tsx::WorkspacePanel": 512,
  "components/StrategyTargetsView.tsx::StrategyTargetsView": 509,
  "components/SettingsPanel.tsx::SettingsPanel": 496,
  "components/BoardToolbar.tsx::BoardToolbar": 491,
  "components/settings/ProjectSettings.tsx::ProjectSettings": 468,
  "components/AllWorkspacesPanel.tsx::AllWorkspacesPanel": 438,
  "components/CreateIssuePanel.tsx::CreateIssuePanel": 353,
  "components/ButlerViewBody.tsx::ButlerViewBody": 415,
  "components/BoardPageView.tsx::BoardPageView": 414,
  "components/TableView.tsx::TableView": 416,
  "components/AddProjectModal.tsx::AddProjectModal": 408,
  "components/PluginActionPanes.tsx::PluginLoopPane": 406,
};

/**
 * There is deliberately NO `SHRINK_GRACE` here any more.
 *
 * #763 shipped one — five entries (`Layout`, `IssueDetailPanel`, `WorkspacePanel`,
 * `SettingsPanel`, `CreateIssuePanel`) whose DOWNWARD enforcement was waived because other
 * agents held those files during the 2026-08-23 wave, so a landing shrink of theirs would have
 * turned this gate red for work they should be credited for. Growth and disappearance were
 * never waived; only the "your number is stale, lower it" half was.
 *
 * #800 emptied it. All five were re-measured on 2026-08-23 with the (now shared) scanner and
 * came back at 717 / 561 / 512 / 496 / 355. Four were exactly their baseline numbers, so the
 * waiver was excusing nothing for them; `CreateIssuePanel` had genuinely shrunk 435 -> 355
 * (`a116dd63de`, #772) and that shrink is banked in the entry above rather than left as
 * budget — which is the one case the waiver would have hidden. The set is deleted rather than left
 * empty: an empty escape hatch still reads as one that may be filled in passing, and the
 * server ring (#800) never had one. The waiver SEMANTICS remain in the shared
 * `compareNlocRatchet`, proven by the synthetic cases in the test, so re-introducing a grace
 * is a deliberate act rather than an existing habit.
 */

/**
 * A function at or above this many nloc must be in the baseline. 400 is chosen, and stated
 * rather than derived, for the reason in the test header: the DMM's own 15-line threshold
 * classifies the codebase's ordinary architectural units — a React component, a
 * `createXService` factory — as oversized, so a gate built on 15 would fail on arrival. 400
 * is more than an order of magnitude above it and still captures every function in this repo
 * that a reader would call unreadable.
 */
export const LIST_THRESHOLD = 400;

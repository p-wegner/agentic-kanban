/**
 * Baseline for function-nloc-ratchet.test.ts (#763).
 *
 * Every client function whose own extent is >= LIST_THRESHOLD (400) non-blank, non-comment
 * lines, MEASURED on 2026-08-23 by the scanner in that test file. Nothing here was copied
 * from a metrics report — see the test's header for why that matters.
 *
 * Only ever LOWER a number or delete a line. The ratchet fails on growth, on a listed
 * function that has vanished, and (outside SHRINK_GRACE) on a number that has become stale.
 */
export const FUNCTION_NLOC_BASELINE: Record<string, number> = {
  "components/Layout.tsx::Layout": 717,
  "components/ButlerView.tsx::ButlerView": 696,
  "components/CreateWorkspaceForm.tsx::CreateWorkspaceForm": 696,
  "routes/BoardPage.tsx::BoardPage": 627,
  "components/WorkspaceCard.tsx::WorkspaceCard": 619,
  "components/BacklogView.tsx::BacklogView": 613,
  "components/IssueDetailPanel.tsx::IssueDetailPanel": 561,
  "components/PluginViewsPanel.tsx::PluginViewsPanel": 551,
  "components/GraphView.tsx::GraphView": 548,
  "hooks/useWorkspaceActions.ts::useWorkspaceActions": 524,
  "components/WorkflowBuilder.tsx::WorkflowBuilder": 516,
  "components/WorkspacePanel.tsx::WorkspacePanel": 512,
  "components/StrategyTargetsView.tsx::StrategyTargetsView": 509,
  "components/SettingsPanel.tsx::SettingsPanel": 496,
  "components/BoardToolbar.tsx::BoardToolbar": 495,
  "components/settings/ProjectSettings.tsx::ProjectSettings": 481,
  "components/AllWorkspacesPanel.tsx::AllWorkspacesPanel": 438,
  "components/CreateIssuePanel.tsx::CreateIssuePanel": 435,
  "components/ButlerViewBody.tsx::ButlerViewBody": 425,
  "components/BoardPageView.tsx::BoardPageView": 417,
  "components/TableView.tsx::TableView": 416,
  "components/AddProjectModal.tsx::AddProjectModal": 408,
  "components/PluginActionPanes.tsx::PluginLoopPane": 406,
};

/**
 * Entries whose exact number is NOT enforced downward yet, because another agent in the
 * 2026-08-23 wave holds the file and a landing edit of theirs would otherwise turn this gate
 * red for a shrink they should be credited for, not blamed for. GROWTH is still forbidden for
 * these, and so is disappearing — only the "your number is stale, lower it" half is waived.
 *
 * This set is temporary scaffolding. Delete an entry as soon as the file is no longer being
 * concurrently edited; the ratchet checks that every name here exists in the baseline, so a
 * ghost entry fails rather than silently excusing nothing.
 */
export const SHRINK_GRACE: readonly string[] = [
  "components/Layout.tsx::Layout",
  "components/IssueDetailPanel.tsx::IssueDetailPanel",
  "components/WorkspacePanel.tsx::WorkspacePanel",
  "components/SettingsPanel.tsx::SettingsPanel",
  "components/CreateIssuePanel.tsx::CreateIssuePanel",
];

/**
 * A function at or above this many nloc must be in the baseline. 400 is chosen, and stated
 * rather than derived, for the reason in the test header: the DMM's own 15-line threshold
 * classifies the codebase's ordinary architectural units — a React component, a
 * `createXService` factory — as oversized, so a gate built on 15 would fail on arrival. 400
 * is more than an order of magnitude above it and still captures every function in this repo
 * that a reader would call unreadable.
 */
export const LIST_THRESHOLD = 400;

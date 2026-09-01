/**
 * Generated baseline for fetch-in-effect-ratchet.test.ts (#603).
 *
 * Separate file so the 89 grandfathered entries do not bury the rule they support.
 * Only ever LOWER a number or delete a line — the ratchet fails on a stale entry.
 *
 * #513 landed `hooks/useApiResource.ts`, so entries are now removed by MIGRATING a panel
 * onto that hook rather than by rewriting its ladder in place.
 *
 * #732 removed four in one go — the windowed dashboard charts (ProviderMix,
 * ProviderCostOverTime, ScorecardDistribution, Throughput) now share
 * `hooks/useWindowedChartData.ts`, which is itself a thin layer over `useApiResource` and
 * so adds no new entry of its own.
 *
 * #972 removed `components/BacklogView.tsx`: its dependency-wave plan fetch moved into
 * `hooks/useDependencyWave.ts`, which rides `useApiResource` rather than re-rolling the
 * ladder — so the entry is deleted, not relocated. The old inline version had no
 * cancelled guard, the exact defect #513 cites as the reason the hook exists.
 */
export const FETCH_IN_EFFECT_BASELINE: Record<string, number> = {
  // #513: THE sanctioned ladder. Every entry below is a hand-rolled copy waiting to be
  // migrated onto this hook; this one line is the destination, not another offender.
  "hooks/useApiResource.ts": 1,
  "components/AllWorkspacesPanel.tsx": 1,
  "components/ArtifactViewer.tsx": 1,
  "components/BoardHealthNotificationCenter.tsx": 1,
  "components/ButlerManageModal.tsx": 1,
  "components/ButlerView.tsx": 3,
  "components/CleanupQueuePanel.tsx": 1,
  "components/CompareAttemptsPanel.tsx": 2,
  "components/CreateIssueForm.tsx": 2,
  "components/CreateIssuePanel.tsx": 1,
  "components/CrimeSceneCityView.tsx": 1,
  "components/CrossRepoImpactHeatmap.tsx": 1,
  "components/DigestView.tsx": 1,
  "components/DriveDashboard.tsx": 3,
  "components/DriveSettingsSection.tsx": 1,
  "components/FailurePatternHint.tsx": 1,
  "components/FileContentionPanel.tsx": 1,
  "components/FlakyTestsPanel.tsx": 1,
  "components/FleetServiceStackMap.tsx": 2,
  "components/FocusView.tsx": 1,
  "components/InsightsPanel.tsx": 2,
  "components/LaunchPreviewPanel.tsx": 1,
  "components/LoopTimeline.tsx": 1,
  "components/MetricsView.tsx": 1,
  "components/MonitorActionReplayDrawer.tsx": 1,
  "components/MonitorCycleHistoryPanel.tsx": 1,
  "components/MonitorCycleTimeline.tsx": 2,
  "components/MonitorPolicyPresets.tsx": 1,
  "components/MonitorPopover.tsx": 2,
  "components/MultirepoHealthPill.tsx": 1,
  "components/OnboardingWizard.tsx": 1,
  "components/PluginActionPanes.tsx": 1,
  "components/PluginScaffoldPane.tsx": 1,
  "components/PluginSkillPane.tsx": 1,
  "components/PluginViewsPanel.tsx": 2,
  "components/PluginViewsTab.tsx": 1,
  "components/ProjectHealthOverview.tsx": 1,
  "components/ProjectScriptsMenu.tsx": 2,
  "components/ProjectScriptsSettingsSection.tsx": 1,
  "components/QualityMetricsView.tsx": 2,
  "components/QuickTasksPanel.tsx": 1,
  "components/RepoMergeStatusStrip.tsx": 1,
  "components/RunbooksView.tsx": 2,
  "components/SessionReplay.tsx": 1,
  "components/SessionTranscriptPanel.tsx": 3,
  "components/SettingsPanel.tsx": 3,
  "components/ShowdownPanel.tsx": 2,
  "components/SlowRequestsPanel.tsx": 1,
  "components/SpecPhasePanel.tsx": 2,
  "components/SprintCapacityPlanner.tsx": 1,
  "components/StackProfileSettingsSection.tsx": 1,
  "components/StrategyTargetsView.tsx": 1,
  "components/TableView.tsx": 1,
  "components/TimeReportPanel.tsx": 1,
  "components/WorkflowAnalyticsDashboard.tsx": 2,
  "components/WorkflowBuilder.tsx": 3,
  "components/WorkflowProgress.tsx": 1,
  "components/WorkflowsView.tsx": 4,
  "components/WorkspaceArtifactsBrowser.tsx": 1,
  "components/WorkspaceDiagnosticsPanel.tsx": 1,
  "components/WorkspaceLaunchFailuresPanel.tsx": 1,
  "components/WorkspaceLifecycleTimeline.tsx": 1,
  "components/WorkspacePanel.tsx": 5,
  "components/WorkspaceRiskHeatmap.tsx": 1,
  "components/WorkspaceTimelinePanel.tsx": 1,
  "components/WorktreeOverview.tsx": 1,
  "components/settings/PluginsSettings.tsx": 1,
  "components/settings/ProviderRotationRingEditor.tsx": 1,
  "components/settings/ScheduleSettings.tsx": 1,
  "hooks/useBoardPreferences.ts": 3,
  "hooks/useCrossRepoActivity.ts": 1,
  "hooks/useIssueDetailData.ts": 2,
  "hooks/useOnboardingStatus.ts": 1,
  "hooks/useOrchestrator.ts": 1,
  "hooks/useRegistrationProgress.ts": 1,
  "hooks/useStaleWorkspaceManager.ts": 1,
  "hooks/useWorkspaceSession.ts": 5,
  "lib/timeEntriesCache.ts": 1,
  "lib/useWebSocket.ts": 1,
};

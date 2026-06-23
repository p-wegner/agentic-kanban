import { useEffect, useState } from "react";
import type { IssueArtifact, IssueWithStatus, DependencyInfo, MilestoneResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { getCachedBundle, revalidateBundle } from "../lib/issueDetailBundleCache.js";
import {
  clearAvailableIssuesCache,
  getCachedAvailableIssues,
  invalidateClientSurfaceLocal,
  setCachedAvailableIssues,
} from "../lib/clientInvalidation.js";
// Type-only imports (erased at compile time, so they don't violate the
// hooks-can't-import-components arch rule).
import type { ActivityEvent } from "../components/IssueActivitySection.js";
import type { IssueComment } from "../components/IssueDetailComments.js";

// Module-level cache for the project-wide issue list feeding the dependency
// picker (it only needs id/issueNumber/title). The list is project-scoped, not
// issue-scoped, so switching cards reuses it instead of refetching the largest
// payload in the app on every panel open. slim=1 omits descriptions (~60% of
// the bytes) — the picker never renders them. Invalidated explicitly when the
// panel creates issues; the short TTL covers out-of-band mutations.
function fetchAvailableIssues(projectId: string): Promise<IssueWithStatus[]> {
  const cached = getCachedAvailableIssues<IssueWithStatus>(projectId);
  if (cached) return Promise.resolve(cached);
  return apiFetch<IssueWithStatus[]>(`/api/issues?projectId=${projectId}&slim=1`).then((data) => {
    setCachedAvailableIssues(projectId, data);
    return data;
  });
}

export function invalidateAvailableIssuesCache(projectId: string) {
  clearAvailableIssuesCache(projectId);
  invalidateClientSurfaceLocal({ surface: "issue-detail", projectId });
}

// Shape of GET /api/issues/:id/detail-bundle — the per-issue panel data folded
// into one response (server-side parallel fetch).
interface IssueDetailBundle {
  issue: { id: string; description: string | null };
  workspaces: { id: string }[];
  tags: { id: string; name: string; color: string | null }[];
  dependencies: DependencyInfo | null;
  artifacts: IssueArtifact[];
  comments: IssueComment[];
  activity: { events: ActivityEvent[] };
}

/**
 * Owns the per-issue panel data: the single detail-bundle round-trip plus the
 * project-scoped lists (tags, available issues, skills, milestones) and the
 * showdown probe. Extracted from IssueDetailPanel so the loadData mega-effect and
 * its ~16 state slots live as one cohesive unit; the panel destructures the
 * result with identical names and keeps its mutation handlers (delete artifact,
 * add note, …) using the returned setters.
 */
export function useIssueDetailData(issue: IssueWithStatus, onIssueUpdate: (issue: IssueWithStatus) => void) {
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [issueTags, setIssueTags] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [allTags, setAllTags] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [dependencies, setDependencies] = useState<DependencyInfo>({ dependencies: [] });
  const [availableIssues, setAvailableIssues] = useState<IssueWithStatus[]>([]);
  const [availableSkills, setAvailableSkills] = useState<{ id: string; name: string; description: string }[]>([]);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [artifacts, setArtifacts] = useState<IssueArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(true);
  const [expandedArtifactId, setExpandedArtifactId] = useState<string | null>(null);
  const [deletingArtifactId, setDeletingArtifactId] = useState<string | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [milestones, setMilestones] = useState<MilestoneResponse[]>([]);
  const [activeShowdownId, setActiveShowdownId] = useState<string | null>(null);
  const [descriptionFetching, setDescriptionFetching] = useState(false);

  useEffect(() => {
    async function loadData() {
      setArtifactsLoading(true);
      setActivityLoading(true);
      setArtifacts([]);
      setExpandedArtifactId(null);
      // Description is stripped from the board payload; the bundle re-supplies it.
      if (issue.description === undefined) setDescriptionFetching(true);
      try {
        // Per-issue data comes in ONE round-trip via the detail-bundle endpoint
        // (workspaces, issue tags, dependencies, comments, artifacts, activity,
        // and the lazy-loaded description), behind a stale-while-revalidate cache
        // (issueDetailBundleCache) that also dedupes concurrent/prefetch fetches.
        const applyBundle = (bundle: IssueDetailBundle) => {
          setWorkspaceCount(bundle.workspaces.length);
          setIssueTags(bundle.tags);
          setDependencies(bundle.dependencies ?? { dependencies: [] });
          setComments(bundle.comments);
          setArtifacts(bundle.artifacts);
          setActivityEvents(bundle.activity.events);
          setArtifactsLoading(false);
          setActivityLoading(false);
          // Feed the lazy-loaded description up to the shared issue object so the
          // separate description fetch is no longer needed.
          if (issue.description === undefined && bundle.issue.description !== undefined) {
            onIssueUpdate({ ...issue, description: bundle.issue.description });
          }
          setDescriptionFetching(false);
        };

        // Instant paint from a cached bundle (recently-viewed ticket / hover
        // prefetch), then always revalidate in the background.
        const cached = getCachedBundle(issue.id);
        if (cached) applyBundle(cached.data as unknown as IssueDetailBundle);

        // Project-scoped data (all tags, available issues, skills, milestones) is
        // the same across every issue in the project — its own cacheable
        // endpoints, fetched in parallel with the bundle revalidation.
        const [bundle, allTagsResp, available, skills, milestonesResp] = await Promise.all([
          revalidateBundle(issue.id) as unknown as Promise<IssueDetailBundle>,
          apiFetch<{ id: string; name: string; color: string | null }[]>(`/api/tags`),
          fetchAvailableIssues(issue.projectId),
          apiFetch<{ id: string; name: string; description: string }[]>(`/api/agent-skills?projectId=${issue.projectId}`).catch(() => [] as { id: string; name: string; description: string }[]),
          apiFetch<MilestoneResponse[]>(`/api/projects/${issue.projectId}/milestones`).catch(() => [] as MilestoneResponse[]),
        ]);
        applyBundle(bundle);
        setAllTags(allTagsResp);
        setAvailableIssues(available.filter(i => i.id !== issue.id));
        setAvailableSkills(skills);
        setMilestones(milestonesResp);
        // Check for active showdown (endpoint returns null when none exists)
        apiFetch<{ id: string } | null>(`/api/issues/${issue.id}/showdown`)
          .then(sd => setActiveShowdownId(sd?.id ?? null))
          .catch(() => {});
      } catch {
        setArtifactsLoading(false);
        setActivityLoading(false);
        setDescriptionFetching(false);
        // Ignore — non-critical
      }
      // Touched-files, related-issues, and merged-commits are owned by their own
      // self-fetching section components — they no longer ride along here.
    }
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.id]);

  return {
    workspaceCount, setWorkspaceCount,
    issueTags, setIssueTags,
    allTags, setAllTags,
    dependencies, setDependencies,
    availableIssues, setAvailableIssues,
    availableSkills, setAvailableSkills,
    comments, setComments,
    artifacts, setArtifacts,
    artifactsLoading, setArtifactsLoading,
    expandedArtifactId, setExpandedArtifactId,
    deletingArtifactId, setDeletingArtifactId,
    activityEvents, setActivityEvents,
    activityLoading, setActivityLoading,
    milestones, setMilestones,
    activeShowdownId, setActiveShowdownId,
    descriptionFetching, setDescriptionFetching,
  };
}

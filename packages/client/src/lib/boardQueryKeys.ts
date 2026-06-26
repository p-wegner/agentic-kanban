/** Central react-query key factory for the board's data graph. Pure data (no
 *  React / hook dependency), so it lives in lib/ — letting lib-layer modules
 *  like clientInvalidation and agentQuestionsStore reference query keys without
 *  up-importing the hooks layer (enforced by lint:arch's client-lib-is-leaf). */
export const boardQueryKeys = {
  activeProjectPreference: ["preferences", "active-project"] as const,
  agentQuestions: (projectId: string) => ["projects", projectId, "agent-questions"] as const,
  archivedProjects: ["projects", "archived"] as const,
  availableIssues: (projectId: string) => ["projects", projectId, "available-issues"] as const,
  board: (projectId: string) => ["projects", projectId, "board"] as const,
  issueDetail: (projectId: string, issueId?: string) => ["projects", projectId, "issue-detail", issueId ?? "all"] as const,
  milestones: (projectId: string) => ["projects", projectId, "milestones"] as const,
  projects: ["projects", "active"] as const,
  settings: ["preferences", "settings"] as const,
  sprintCapacity: (projectId: string) => ["projects", projectId, "sprint-capacity"] as const,
  tags: ["tags"] as const,
  workspaceIssue: (projectId: string, issueId?: string) => ["projects", projectId, "workspaces", issueId ?? "all"] as const,
};

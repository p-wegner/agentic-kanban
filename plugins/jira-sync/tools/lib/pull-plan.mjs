// The deterministic core of a pull: diff what Jira reports against the last
// known state, with no side effects. Shared by `tools/plan.mjs` (always a dry
// run) and `tools/sync/pull.mjs` (which also applies the plan unless --dry-run).

const FIELDS = ["summary", "status", "updated"];

export function defaultJql({ projectKey, jql }) {
  if (jql) return jql;
  if (!projectKey) throw new Error("either JIRA_JQL or JIRA_PROJECT_KEY must be set");
  return `project = ${projectKey} ORDER BY updated ASC`;
}

/**
 * @param {import("./jira-client.mjs").JiraClient} client
 * @param {{ jql: string, knownState: { issues: Record<string, {updated:string}> } }} opts
 */
export async function buildPullPlan(client, { jql, knownState }) {
  const actions = [];
  for await (const issue of client.searchAll(jql, { fields: FIELDS })) {
    const known = knownState.issues[issue.key];
    const updated = issue.fields?.updated ?? null;
    const action = !known ? "create" : known.updated !== updated ? "update" : "unchanged";
    actions.push({
      key: issue.key,
      action,
      summary: issue.fields?.summary ?? null,
      status: issue.fields?.status?.name ?? null,
      updated,
    });
  }
  return {
    jql,
    total: actions.length,
    toCreate: actions.filter((a) => a.action === "create").length,
    toUpdate: actions.filter((a) => a.action === "update").length,
    unchanged: actions.filter((a) => a.action === "unchanged").length,
    actions,
  };
}

/** Folds an applied plan into the next `knownState`, for pull.mjs to persist. */
export function applyPlanToState(plan, knownState) {
  const next = { issues: { ...knownState.issues } };
  for (const action of plan.actions) {
    next.issues[action.key] = { updated: action.updated };
  }
  return next;
}

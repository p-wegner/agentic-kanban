/**
 * Live one-shot dispatches to fleet workers (#1468).
 *
 * A one-shot (a merge-train fix agent, for example) has no session row, so the git-http push
 * authorization, which looks for a current SESSION dispatch, refused its `kanban-oneshot/<id>`
 * branch once the token's settle window had passed. The dispatcher registers the branch here
 * for as long as it awaits the worker's result; the authorization accepts a registered one.
 */
const live = new Map<string, number>();

function key(workerId: string, projectId: string, branch: string): string {
  return `${workerId}\u0000${projectId}\u0000${branch}`;
}

/** Record a one-shot dispatch; returns the function that ends it. */
export function registerOneShotDispatch(workerId: string, projectId: string, branch: string): () => void {
  const k = key(workerId, projectId, branch);
  live.set(k, (live.get(k) ?? 0) + 1);
  return () => {
    const n = (live.get(k) ?? 1) - 1;
    if (n <= 0) live.delete(k);
    else live.set(k, n);
  };
}

export function isOneShotDispatchLive(workerId: string, projectId: string, branch: string): boolean {
  return live.has(key(workerId, projectId, branch));
}

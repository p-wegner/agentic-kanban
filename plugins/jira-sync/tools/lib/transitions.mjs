// Resolves a target board-status NAME to a Jira transition id by walking the
// transition graph Jira itself reports for the issue (`client.listTransitions`)
// — never a hardcoded id, since transition ids are workflow- and issue-type-
// specific and differ per project.

export class TransitionNotFoundError extends Error {
  constructor(targetStatus, available) {
    super(`no transition to status "${targetStatus}" (available: ${available.join(", ") || "none"})`);
    this.name = "TransitionNotFoundError";
    this.targetStatus = targetStatus;
    this.available = available;
  }
}

/**
 * @param {Array<{id:string,name:string,to?:{name?:string}}>} transitions — from client.listTransitions()
 * @param {string} targetStatus — the board status name to reach
 * @returns {string} the transition id
 * @throws {TransitionNotFoundError} when no transition reaches targetStatus
 */
export function resolveTransitionId(transitions, targetStatus) {
  const match = transitions.find((t) => t.to?.name === targetStatus);
  if (!match) {
    throw new TransitionNotFoundError(
      targetStatus,
      transitions.map((t) => t.to?.name).filter(Boolean),
    );
  }
  return match.id;
}

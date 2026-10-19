// Resolves a target board-status NAME to a Jira transition id by walking the
// transition graph Jira itself reports for the issue (`client.listTransitions`)
// — never a hardcoded id, since transition ids are workflow- and issue-type-
// specific and differ per project.
//
// Resolution order (#1623): an explicitly configured board-status -> Jira-status
// override, then an exact destination-name match, then the board status's
// CATEGORY against `to.statusCategory.key` (so localized/renamed workflows
// such as "Zu erledigen / In Arbeit / Fertig" still resolve).

export class TransitionNotFoundError extends Error {
  constructor(targetStatus, available) {
    super(`no transition to status "${targetStatus}" (available: ${available.join(", ") || "none"})`);
    this.name = "TransitionNotFoundError";
    this.targetStatus = targetStatus;
    this.available = available;
  }
}

export class TransitionAmbiguousError extends TransitionNotFoundError {
  constructor(targetStatus, candidates) {
    super(targetStatus, candidates);
    this.message = `ambiguous transition to status "${targetStatus}": ${candidates.length} candidates match (${candidates.join(", ")}); configure a status map to pick one`;
    this.name = "TransitionAmbiguousError";
    this.candidates = candidates;
  }
}

/** Board status name (lowercased) -> Jira statusCategory.key. */
const BOARD_STATUS_CATEGORY = {
  backlog: "new",
  todo: "new",
  "to do": "new",
  "in progress": "indeterminate",
  "in review": "indeterminate",
  done: "done",
};

export function categoryForBoardStatus(name) {
  return BOARD_STATUS_CATEGORY[String(name ?? "").trim().toLowerCase()] ?? null;
}

const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * @param {Array<{id:string,name:string,to?:{name?:string,statusCategory?:{key?:string}}}>} transitions — from client.listTransitions()
 * @param {string} targetStatus — the board status name to reach
 * @param {{ overrides?: Record<string,string> }} [opts] — board status -> Jira status name
 * @returns {string} the transition id
 * @throws {TransitionNotFoundError} when no transition reaches targetStatus (TransitionAmbiguousError when several do)
 */
export function resolveTransitionId(transitions, targetStatus, { overrides = {} } = {}) {
  const names = () => transitions.map((t) => t.to?.name).filter(Boolean);

  const overrideKey = Object.keys(overrides).find((k) => sameName(k, targetStatus));
  if (overrideKey) {
    const match = transitions.find((t) => sameName(t.to?.name, overrides[overrideKey]));
    if (!match) throw new TransitionNotFoundError(overrides[overrideKey], names());
    return match.id;
  }

  const exact = transitions.find((t) => t.to?.name === targetStatus);
  if (exact) return exact.id;

  const category = categoryForBoardStatus(targetStatus);
  const byCategory = category ? transitions.filter((t) => t.to?.statusCategory?.key === category) : [];
  if (byCategory.length === 1) return byCategory[0].id;
  if (byCategory.length > 1) {
    throw new TransitionAmbiguousError(targetStatus, byCategory.map((t) => t.to?.name ?? t.name));
  }
  throw new TransitionNotFoundError(targetStatus, names());
}

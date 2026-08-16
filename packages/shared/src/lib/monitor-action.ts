// The monitor's action vocabulary (#578).
//
// This union lived in `server/src/services/monitor-nudge.ts` with NINE members while the
// client re-declared SEVEN in `lib/monitor-popover.ts`. The client's `ACTION_LABELS` is a
// `Record<MonitorAction["action"], …>` indexed unguarded, so once `auto_contract` ran, the
// Recent-actions list read `meta.color` off `undefined` and the popover crashed.
//
// Sharing the union means the client's Record fails TYPECHECK when the server gains an
// action, instead of crashing in front of a user. That is the whole point of putting it
// here rather than adding the two missing keys and moving on.
//
// Pure: no node imports, safe from the client bundle.

export const MONITOR_ACTION_NAMES = [
  "relaunch",
  "merge",
  "nudge",
  "mark_idle",
  "mark_dead",
  "auto_start",
  "generate_tickets",
  "auto_contract",
  "auto_contract_suggest",
] as const;

export type MonitorActionName = (typeof MONITOR_ACTION_NAMES)[number];

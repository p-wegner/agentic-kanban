/**
 * Identifies sessions that are "analytics noise" — meta-sessions representing
 * monitoring, health-check, or board-navigation activities rather than
 * meaningful agent implementation work.
 *
 * Noise sessions are excluded from:
 * - Workspace session counts used for stuck-detection in the monitor cycle
 * - The "latest session" shown in board analytics and CLI status
 * - The "last agent message" displayed per workspace
 */

/** Trigger types whose sessions should not count as real implementation work. */
export const NOISE_TRIGGER_TYPES: readonly string[] = [
  "skill:board-monitor",
  "skill:board-navigator",
];

const NOISE_TRIGGER_SET = new Set<string>(NOISE_TRIGGER_TYPES);

/**
 * Returns true if the session is analytics noise and should be excluded from
 * retry counts, success metrics, and the "latest session" display.
 */
export function isAnalyticsNoise(session: { triggerType?: string | null }): boolean {
  const t = session.triggerType;
  if (!t) return false;
  return NOISE_TRIGGER_SET.has(t);
}

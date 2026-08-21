/**
 * Pure edge-detector for SessionTranscriptPanel's trailing refetch (#672).
 *
 * The panel stops polling the instant a session is observed as no longer
 * running, so a session that exits right after its final stdout write can get
 * stuck showing stale content — there is no later trigger to pick up the tail.
 * A running→ended transition is exactly the one moment a final catch-up
 * refetch is worth scheduling.
 */
export function isRunningToEndedTransition(wasRunning: boolean, isRunningNow: boolean): boolean {
  return wasRunning && !isRunningNow;
}

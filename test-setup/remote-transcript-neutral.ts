/**
 * Keep unit tests from writing remote-session transcripts into the REAL %TEMP% (#1348).
 *
 * `createRemoteAgentService` appends each streamed stdout chunk to
 * `%TEMP%/kanban-session-<id>.out` (#1333). The older agent-remote suites all use session id
 * `s1`, so every run left a stray `kanban-session-s1.out` that `ingestSession` then preferred
 * over `test-run.service.test.ts`'s own `s1` DB rows. Deleting it in teardown cannot work with
 * parallel workers, so the default sink is switched off here instead; a test that wants the
 * real sink calls `persistRemoteStdout` directly (agent-remote-transcript.test.ts).
 *
 * An explicit `KANBAN_REMOTE_TRANSCRIPT` from the environment wins.
 */
if (process.env.KANBAN_REMOTE_TRANSCRIPT === undefined) {
  process.env.KANBAN_REMOTE_TRANSCRIPT = "off";
}

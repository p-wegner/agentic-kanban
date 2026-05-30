# In-flight Merge Run Friction

## What happened

On 2026-05-30, a run to finish several old in-flight board workspaces took about 2h 26m. Transcript inspection showed the main delay was not implementation work. The parent session made 383 shell calls and spent about 100 minutes in explicit `Start-Sleep` polling.

The worst sessions were fix-and-merge attempts for #129 and #130. Their board sessions looked active for minutes, but the Codex provider transcripts were approximately 1 second long with 0 tokens and no assistant output. That means the launch failed or became stale before useful model work happened.

## Lessons

- Do not resume many stale/idle workspaces at once. Start one, then at most two after server health and touched-file overlap are clear.
- Treat a 1-second, zero-token provider transcript as a failed launch. Stop the board session and inspect the branch instead of waiting.
- For old conflict-heavy branches, compare branch history against current `master` early. Rebuilding from current `master` and cherry-picking issue-specific commits can be safer than repeated generic fix-and-merge sessions.
- Stale merge locks must be deterministic app state, not something agents clear by restarting the dev server.

## Follow-up tickets

- #169 Detect and fail zero-output agent launch sessions
- #170 Add stale merge-lock recovery and diagnostics
- #171 Throttle stale workspace recovery and bulk resume concurrency
- #172 Add deterministic stale-branch rebuild strategy before fix-and-merge

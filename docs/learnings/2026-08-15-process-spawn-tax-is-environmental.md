# The board's slowness on this machine is largely a PROCESS-SPAWN TAX, not board code (#368)

_Recorded 2026-08-15. Supersedes the framing of #359 and much of the perf work around it._

## The decisive control (MEASURED)

Run back-to-back on a verified-quiet machine — 0 leaked fixture processes, 0 vitest:

| command | does repository work? | observed |
|---|---|---|
| `git --version` | **no** | 3498 / 4046 / 4792 / 5477 / 3919 / 3576 ms |
| `git rev-parse HEAD` | **yes** | 3325 / 3104 / 3008 / 3680 / 2824 / 3650 ms |
| `node --version` | no | 1540 / 1315 / 817 / 877 ms |
| `cmd /c ver` | no | 977 / 1103 / 1183 / 2285 ms |

**`git --version` is SLOWER than `git rev-parse HEAD`.** A command that opens no repository, reads
no objects and touches no index costs more than one that does. Repository size, object count and
index state are therefore irrelevant to this cost.

Two distinct effects:

1. **A ~1s floor on ANY process spawn** (`node --version`, `cmd /c ver`). On a healthy Windows box
   this should be tens of milliseconds. Not git-specific.
2. **A further ~2-3× penalty specific to `git.exe`** (~3-5s vs ~1s).

## What this reframes

Several confident code-level diagnoses were describing the shadow of an environment problem:

- the #359 memoization removed only 7-25% of spawns (median 12%) and was correctly declined;
- `blockingMs: 0` on every monitor cycle, yet `/api/health` shows a multi-second tail — the event
  loop is not blocked, the board is waiting on child processes;
- `/api/health` is **bimodal** (quiet p50 0.003s, tail to 17.58s): fast when no cycle is spawning
  git, slow when one is;
- cycle totals stayed in a band while the *dominant phase moved four times* — the cost follows
  wherever the git spawns happen to be, which is what a per-spawn tax looks like.

## The reporting rule this creates

**Every board-side latency figure taken on this machine is provisional, including the ones
reported as improvements.** A perf claim needs a simultaneous control spawn (`git --version` beside
the measurement) or it must be labelled UNVERIFIED. Do not attach a duration target to a ticket
whose numbers came from here — #388 was written and implemented under that rule.

## The likely cause (INFERRED, NOT confirmed)

On-access antivirus scanning of every spawned executable. Supporting but not conclusive:
`Get-MpComputerStatus` reports `RealTimeProtectionEnabled: True` and `AntivirusEnabled: True`
(re-confirmed 2026-08-15). Whether the repos, `node.exe`, `git.exe` or the pnpm store are excluded
**cannot be determined without elevation** — under a non-elevated shell `Get-MpPreference` returns
`"N/A: Must be an administrator to view exclusions"` for both `ExclusionPath` and
`ExclusionProcess` (also re-confirmed).

Not ruled out: a filesystem filter driver other than Defender (corporate EDR), Windows Defender
Application Control / SmartScreen reputation checks, a slow `PATH` search, a network-mounted
profile.

## What is left, cheapest first

1. **From an ELEVATED shell** — the one step nobody without admin can take, and a two-minute check
   that either confirms or kills the hypothesis:

   ```powershell
   Get-MpPreference | Select-Object ExclusionPath, ExclusionProcess
   ```

2. If unexcluded, add exclusions for `C:\projects\`, the worktree root, `git.exe`, `node.exe` and
   the pnpm store, then **re-run the control table above**. If antivirus is the cause, the ~1s
   floor and the git penalty collapse.
3. Only then re-measure the monitor cycle.
4. The remaining code-side lever is reducing the NUMBER of spawns — batching several queries into
   one git invocation, or a long-lived `git cat-file --batch`-style process — **not** caching their
   results. That conclusion is unchanged by the environment fix, but its payoff scales with the
   per-spawn cost, so it should be sized after step 2, not before.

## Scope

This is a property of THIS machine. It does not necessarily affect other installations, and the
board's own code is not implicated in the ~1s spawn floor at all.

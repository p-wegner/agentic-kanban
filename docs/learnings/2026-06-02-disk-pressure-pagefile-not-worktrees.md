# Disk Pressure During Board Operation: Check `pagefile.sys` / `hiberfil.sys` Before Blaming Worktrees

## What happened

On 2026-06-02 the long-running orchestrator-monitoring session (a `/loop`-style
"monitor the board-monitor, check in every 30 min" session running interactively from the
**main checkout on master**) spent ~18 hours treating a slow C: drive fill-up as a
**git-worktree accumulation** problem.

The reasoning was plausible and partly correct:

- `git worktree list` showed **22 → 31 registered worktrees** for a board with only ~2–3
  active issues, each carrying ~300–500 MB of `node_modules` (`.worktrees` reached **9.2 GB**).
- Most were "limbo" worktrees: workspace records never closed after merge because of the
  Windows **EBUSY / merge-cleanup gap** (already ticketed as **#241 / #277**).
- The first symptom, a day earlier, was the monitor's Playwright frontend-smoke check dying
  with **`ENOSPC: no space left on device`** when the daemon couldn't write.
- The accumulation also correlated with board API latency ballooning to **14.5 s → 17.9 s**.

The session monitored `Get-PSDrive C` **111 times** as free space eroded 14 → 9.9 → 7.3 →
**5.4 GB**, and exhausted every *safe* reclaim lever it had:

- The orphan-worktree sweep (`scripts/cleanup-orphan-worktrees.ps1`) found ~9 orphans but
  **7 were locked** (AV scanning freshly-merged worktrees) and freed only ~0.1 GB.
- `pnpm cli -- cleanup` (board-aware) reported **0 closed worktrees** — the board still
  considered all 31 as open, so nothing was sanctioned for removal.

It correctly **refused to force-remove the ~24 limbo worktrees** unsupervised (4 were
genuinely In Progress, board state ambiguous) and escalated to the user with reclaim
options (Docker `docker_data.vhdx` 38 GB, force-remove verified-closed worktrees, lower WIP).

**The actual disk hog was none of those.** When the user asked *"what about pagefile and
hiberfile?"*, a 30-second check found:

| File | Size | Reality |
|---|---|---|
| `pagefile.sys` | **49.8 GB allocated** | only **7.4 GB** ever used (peak); Windows sized it to ~RAM (43.8 GB) |
| `hiberfil.sys` | ~17.5 GB | reclaimable instantly via `powercfg /h off` |

A single `powercfg /h off` reclaims **+17.5 GB with no reboot** (C: 5.3 → ~23 GB), defusing
the situation so the worktree accumulation and Docker never need to be touched. Capping the
pagefile (e.g. Initial 8 GB / Max 16 GB) reclaims ~30 GB more (needs a reboot).

## Lessons

- **When C: fills on this Windows laptop, check the big single files FIRST.** `pagefile.sys`
  and `hiberfil.sys` are routinely the two largest files on C: (tens of GB) and are sized to
  RAM, *independent* of project churn. On a 44 GB-RAM laptop that has slept, that's ~50 GB of
  pagefile + ~17 GB of hibernation = the dominant consumer. Run a "largest files on C:" /
  pagefile + hiberfile check before spending hours on worktree/node_modules cleanup.

- **Worktree/`node_modules` accumulation is a real but secondary driver.** It's genuinely a
  bug (#241/#277: merged workspaces leave non-empty worktrees due to Windows EBUSY) and it
  does inflate board-aggregation latency — but at ~9 GB it was less than a quarter of what the
  pagefile alone was holding. Don't let the *ticketed, familiar* cause crowd out a check of the
  *unfamiliar, larger* one.

- **The agent's PowerShell tool is not elevated.** `powercfg /h off` and pagefile changes
  (`wmic ... AutomaticManagedPagefile=False` / `set InitialSize=...,MaximumSize=...`) fail with
  "Zugriff verweigert / Access denied" from the tool. Surface the exact elevated commands for
  the user to run in an Admin terminal rather than retrying — they will never succeed in-tool.

- **Escalating instead of force-deleting ambiguous worktrees was the right call.** The board
  records were ambiguous (only 1 of 31 sanctioned for removal, 4 genuinely In Progress).
  Bulk `git worktree remove --force` would have risked live work. A disk pre-commitment
  (throttle the loop below 4 GB free to avoid a 0-byte crash) plus a user decision was correct.

## Quick reclaim checklist (this machine)

```powershell
# 1. See where the space went — biggest single files on C:
Get-PSDrive C | Select-Object Used,Free
fsutil volume diskfree C:
# pagefile + hiberfile (the usual culprits)
Get-CimInstance Win32_PageFileUsage | Select-Object Name,AllocatedBaseSize,CurrentUsage,PeakUsage

# 2. Fastest no-reboot win (ADMIN terminal): reclaim hibernation file
powercfg /h off                       # +~17.5 GB instantly

# 3. Cap the oversized pagefile (ADMIN; needs reboot): reclaim ~30 GB
wmic computersystem set AutomaticManagedPagefile=False
wmic pagefileset where name="C:\pagefile.sys" set InitialSize=8192,MaximumSize=16384

# 4. Only then, project-side: board-aware worktree cleanup (safe), Docker prune
pnpm cli -- cleanup                    # removes board-confirmed-closed worktrees
```

## Related

- Worktree-accumulation root bugs: **#241** (merge cleanup leaves non-empty worktrees on EBUSY),
  **#277** (workspace records not closed after merge).
- Prior monitor learning: `docs/learnings/2026-05-31-monitor-harness-requires-stop-hooks.md`.
- Server crash on worktree-cleanup EBUSY: **#154**.

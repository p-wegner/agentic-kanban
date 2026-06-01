# One-off: remove DEAD orphan worktree directories left behind by EBUSY-failed
# `git worktree remove` (Windows rmdir failures). Most carry a ~300 MB node_modules,
# so this reclaims ~tens of GB. SAFETY GUARDS (all must hold per dir):
#   1. dir name matches feature_ak-*           (only real worktree folders)
#   2. NOT in the live `git worktree list`      (active worktrees preserved)
#   3. has NO .git entry                        (git can't operate -> dead)
# Active set is re-derived from git at runtime, so this is safe to re-run.
# Uses `rd /s /q` (cmd) — far faster than Remove-Item -Recurse on node_modules trees.
$repo = 'C:\andrena\agentic-kanban'
$root = 'C:\andrena\.worktrees'

$active = & git -C $repo worktree list --porcelain |
  Where-Object { $_ -like 'worktree *' } |
  ForEach-Object { Split-Path ($_ -replace '^worktree ','') -Leaf }

$before  = (Get-PSDrive C).Free
$deleted = 0; $failed = @()
foreach ($d in (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue)) {
  if ($d.Name -notlike 'feature_ak-*') { continue }          # guard 1
  if ($active -contains $d.Name)       { continue }          # guard 2
  if (Test-Path (Join-Path $d.FullName '.git')) { continue } # guard 3
  & cmd /c rd /s /q "$($d.FullName)" 2>$null
  if (Test-Path $d.FullName) { $failed += $d.Name } else { $deleted++ }
}
$after = (Get-PSDrive C).Free
Write-Host ("Deleted {0} orphan worktrees. Failed/locked: {1}." -f $deleted, $failed.Count)
if ($failed.Count) { Write-Host 'Still present (locked/in-use):'; $failed | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" } }
Write-Host ("Freed: {0:N1} GB   Free now: {1:N1} GB" -f (($after-$before)/1GB), ($after/1GB))
Write-Host ("Remaining feature_ak-* dirs: {0}" -f (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'feature_ak-*' }).Count)

# One-off: reclaim disk by deleting JetBrains per-version dirs for IDE versions
# <= 2024.2 (superseded by 2024.3 / 2025.1, which already hold forward-migrated
# settings). Uses an explicit DELETE allowlist + a KEEP guard so nothing current
# or infrastructure (Installations/Toolbox/Daemon/Shared) is ever touched.
$delete = @(
  'IdeaIC2023.2','IdeaIC2023.3','IdeaIC2024.2',
  'IntelliJIdea2023.2',
  'PyCharmCE2024.2',
  'Rider2023.2','Rider2023.3','Rider2024.1'
)
$keepGuard = @('IdeaIC2024.3','IdeaIC2025.1','Rider2024.2',
               'Installations','Toolbox','Toolbox-Dev','Daemon','Shared','dotCover','~')
$roots = @('C:\Users\pwegner\AppData\Local\JetBrains','C:\Users\pwegner\AppData\Roaming\JetBrains')

$before = (Get-PSDrive C).Free
$removed = @(); $failed = @()
foreach ($root in $roots) {
  foreach ($d in (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue)) {
    if ($keepGuard -contains $d.Name) { continue }   # never touch current/infra
    if ($delete -notcontains $d.Name) { continue }    # only the explicit old versions
    & cmd /c rd /s /q "$($d.FullName)" 2>$null
    if (Test-Path $d.FullName) { $failed += "$root\$($d.Name)" } else { $removed += "$root\$($d.Name)" }
  }
}
$after = (Get-PSDrive C).Free
Write-Host ("Removed {0} dirs. Failed/locked: {1}." -f $removed.Count, $failed.Count)
$removed | ForEach-Object { Write-Host "  - $_" }
if ($failed.Count) { Write-Host 'LOCKED (IDE running?):'; $failed | ForEach-Object { Write-Host "  ! $_" } }
Write-Host ("Freed: {0:N1} GB   Free now: {1:N1} GB" -f (($after-$before)/1GB), ($after/1GB))

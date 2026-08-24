# Regression test: which processes the "daemon" filter matches.
#
# The bug was not that it picked the wrong process in some fixed order -- it was
# that THREE processes matched at all, so `Select-Object -First 1` returned
# whichever Win32_Process happened to enumerate first. On this machine that was
# the tray, so -Stop killed the tray and reported "stopped".
$fixtures = @(
  @{ n='daemon';     Name='node.exe';       CL='"C:\...\node.exe" C:\...\node_modules/agentic-kanban/bin/worker.js start --board http://100.105.24.76:3003 --name AO-PF38Z8R8' }
  @{ n='tray';       Name='powershell.exe'; CL='"C:\...\powershell.exe" -NoProfile -File "C:\andrena\agentic-kanban\packages\server\tools\worker-windows\ak-worker-tray.ps1"' }
  @{ n='dashboard';  Name='node.exe';       CL='node "C:\andrena\agentic-kanban\packages\server\tools\worker-windows\ak-worker-dashboard.mjs" --open' }
  @{ n='supervisor'; Name='powershell.exe'; CL='"C:\...\powershell.exe" -NoProfile -File "C:\andrena\agentic-kanban\packages\server\tools\worker-windows\ak-worker-run.ps1"' }
)
$old = { param($p) $p | Where-Object { $_.CL -like '*agentic-kanban*' -and $_.CL -like '*worker*' -and $_.CL -notlike '*ak-worker-run.ps1*' } }
$new = { param($p) $p | Where-Object { $_.Name -eq 'node.exe' -and $_.CL -like '*--board*' -and $_.CL -notlike '*ak-worker-run.ps1*' } }
$fail = 0
function Check($label, $got, $want) {
  $g = (@($got) | ForEach-Object { $_.n } | Sort-Object) -join ','
  $w = ($want | Sort-Object) -join ','
  if ($g -eq $w) { Write-Output "OK   $label -> [$g]" }
  else { Write-Output "FAIL $label -> [$g] expected [$w]"; $script:fail = 1 }
}
Check 'old filter (documents the bug)' (& $old $fixtures) @('daemon','tray','dashboard')
Check 'new filter, all running'        (& $new $fixtures) @('daemon')
Check 'new filter, daemon NOT running' (& $new ($fixtures | Where-Object { $_.n -ne 'daemon' })) @()
Check 'old filter, daemon NOT running' (& $old ($fixtures | Where-Object { $_.n -ne 'daemon' })) @('tray','dashboard')
Write-Output ''
Write-Output 'The last line is the damage: with no daemon running, the old filter still'
Write-Output 'returned two processes, so -Stop killed the tray and printed "stopped".'
if ($fail) { Write-Output 'TESTS FAILED'; exit 1 } else { Write-Output 'TESTS PASSED'; exit 0 }

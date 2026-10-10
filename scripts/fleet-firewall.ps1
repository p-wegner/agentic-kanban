<#
.SYNOPSIS
  Windows Firewall rules for the fleet + git listeners, scoped to the tailnet (#1326).

.DESCRIPTION
  docs/worker-fleet.md section 6: the fleet port and the git transport port carry the `assign`
  frame (an RCE channel into every worker), so they must be reachable from the tailnet ONLY -
  never from LAN/wifi. A hand-made rule is easily profile-wide. This script adds exactly two
  inbound allow rules (one per port), TCP, restricted to RemoteAddress 100.64.0.0/10 (the
  Tailscale CGNAT range) and, when present, the Tailscale interface alias.

  Rule names are fixed ("agentic-kanban fleet <port>" / "agentic-kanban git <port>") so
  -Status and -Remove find them, and `worker doctor-board` checks for them.

  Ports default to ~/.agentic-kanban/fleet.json (fleetPort / gitHttpPort), then the
  KANBAN_FLEET_PORT / KANBAN_GIT_HTTP_PORT env vars; override with -FleetPort / -GitPort.

.EXAMPLE
  .\scripts\fleet-firewall.ps1 -Install     # elevated shell
  .\scripts\fleet-firewall.ps1 -Status
  .\scripts\fleet-firewall.ps1 -Remove      # elevated shell
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status,
  [int]$FleetPort = 0,
  [int]$GitPort = 0
)

$ErrorActionPreference = "Stop"
$RulePrefix = "agentic-kanban"
$TailnetRange = "100.64.0.0/10"

$modes = @($Install, $Remove, $Status) | Where-Object { $_ }
if ($modes.Count -ne 1) {
  Write-Host "Usage: fleet-firewall.ps1 -Install | -Remove | -Status [-FleetPort <n>] [-GitPort <n>]"
  exit 2
}

function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-Ports {
  $fleet = $FleetPort
  $git = $GitPort
  $file = Join-Path $env:USERPROFILE ".agentic-kanban\fleet.json"
  if ((Test-Path $file) -and ($fleet -eq 0 -or $git -eq 0)) {
    try {
      $cfg = Get-Content $file -Raw | ConvertFrom-Json
      if ($fleet -eq 0 -and $cfg.fleetPort) { $fleet = [int]$cfg.fleetPort }
      if ($git -eq 0 -and $cfg.gitHttpPort) { $git = [int]$cfg.gitHttpPort }
    } catch { }
  }
  if ($fleet -eq 0 -and $env:KANBAN_FLEET_PORT) { $fleet = [int]$env:KANBAN_FLEET_PORT }
  if ($git -eq 0 -and $env:KANBAN_GIT_HTTP_PORT) { $git = [int]$env:KANBAN_GIT_HTTP_PORT }
  return @{ Fleet = $fleet; Git = $git }
}

function Get-OurRules {
  return @(Get-NetFirewallRule -DisplayName "$RulePrefix *" -ErrorAction SilentlyContinue)
}

function Show-Status {
  $rules = Get-OurRules
  if ($rules.Count -eq 0) {
    Write-Host "No '$RulePrefix' firewall rules found. Run -Install from an elevated shell."
    return
  }
  foreach ($r in $rules) {
    $port = ($r | Get-NetFirewallPortFilter).LocalPort
    $addr = ($r | Get-NetFirewallAddressFilter).RemoteAddress
    $iface = ($r | Get-NetFirewallInterfaceFilter).InterfaceAlias
    Write-Host ("{0}  enabled={1} action={2} dir={3} port={4} remote={5} interface={6}" -f $r.DisplayName, $r.Enabled, $r.Action, $r.Direction, $port, ($addr -join ","), ($iface -join ","))
    if (($addr -join ",") -ne $TailnetRange) {
      Write-Warning "  remote address is not $TailnetRange - this rule may be reachable from outside the tailnet."
    }
  }
}

if ($Status) { Show-Status; exit 0 }

if (-not (Test-Elevated)) {
  Write-Host "fleet-firewall.ps1 -$(if ($Install) { 'Install' } else { 'Remove' }) needs an ELEVATED shell (Run as administrator)."
  Write-Host "Firewall rules cannot be changed from a normal shell; nothing was changed."
  exit 3
}

if ($Remove) {
  $rules = Get-OurRules
  if ($rules.Count -eq 0) { Write-Host "Nothing to remove."; exit 0 }
  foreach ($r in $rules) { Write-Host "Removing $($r.DisplayName)"; $r | Remove-NetFirewallRule }
  exit 0
}

$ports = Resolve-Ports
if ($ports.Fleet -eq 0 -or $ports.Git -eq 0) {
  Write-Host "Could not determine both ports. Pass -FleetPort and -GitPort (or set fleet.json / KANBAN_FLEET_PORT / KANBAN_GIT_HTTP_PORT)."
  exit 2
}

# Replace rather than stack: a rule from an earlier install on another port would stay open.
foreach ($r in Get-OurRules) { $r | Remove-NetFirewallRule }

# Scope to the Tailscale interface too when it exists; the address restriction alone is the floor.
$ts = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "Tailscale*" } | Select-Object -First 1

foreach ($spec in @(@{ Kind = "fleet"; Port = $ports.Fleet }, @{ Kind = "git"; Port = $ports.Git })) {
  $ruleArgs = @{
    DisplayName   = "$RulePrefix $($spec.Kind) $($spec.Port)"
    Description   = "agentic-kanban $($spec.Kind) listener, tailnet only (#1326). Do not widen."
    Direction     = "Inbound"
    Action        = "Allow"
    Protocol      = "TCP"
    LocalPort     = $spec.Port
    RemoteAddress = $TailnetRange
    Profile       = "Any"
  }
  if ($ts) { $ruleArgs.InterfaceAlias = $ts.Name }
  New-NetFirewallRule @args | Out-Null
  Write-Host "Added '$($ruleArgs.DisplayName)' (remote $TailnetRange$(if ($ts) { ", interface $($ts.Name)" }))"
}
if (-not $ts) { Write-Host "No Tailscale interface found; rules are restricted by remote address only." }


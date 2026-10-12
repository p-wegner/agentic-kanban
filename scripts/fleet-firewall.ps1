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

  -Wsl (#1378) adds/removes a SECOND pair of rules, named "agentic-kanban wsl fleet|git <port>",
  scoped to the WSL vEthernet subnet (found from the "vEthernet (WSL*)" adapter, or pass -WslSubnet)
  and to that interface alias - so a WSL worker on the same laptop can reach the listeners
  (NAT: the distro reaches the host through the vEthernet gateway). Never LAN/WLAN. -Install -Wsl
  and -Remove -Wsl leave the tailnet rules alone; plain -Install / -Remove keep their old meaning
  for the tailnet pair but -Remove also drops the wsl pair. The listener must also be bound to an
  address the distro can reach (the vEthernet gateway IP or 0.0.0.0 with this rule as the guard).

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
  [switch]$Wsl,
  [int]$FleetPort = 0,
  [int]$GitPort = 0,
  [string]$WslSubnet = ""
)

$ErrorActionPreference = "Stop"
$RulePrefix = "agentic-kanban"
$TailnetRange = "100.64.0.0/10"

$modes = @($Install, $Remove, $Status) | Where-Object { $_ }
if ($modes.Count -ne 1) {
  Write-Host "Usage: fleet-firewall.ps1 -Install | -Remove | -Status [-Wsl] [-FleetPort <n>] [-GitPort <n>] [-WslSubnet a.b.c.d/n]"
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

function Test-WslRule($r) { return $r.DisplayName -like "$RulePrefix wsl *" }

# The WSL NAT subnet (e.g. 172.28.16.0/20): the vEthernet (WSL*) adapter's address + prefix, masked to network form.
function Get-WslAdapter {
  return Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "vEthernet (WSL*" } | Select-Object -First 1
}

function Resolve-WslSubnet($adapter) {
  if ($WslSubnet) { return $WslSubnet }
  if (-not $adapter) { return $null }
  $ip = Get-NetIPAddress -InterfaceAlias $adapter.Name -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $ip) { return $null }
  $addr = [System.Net.IPAddress]::Parse($ip.IPAddress).GetAddressBytes()
  $bits = [int]$ip.PrefixLength
  $net = New-Object byte[] 4
  for ($i = 0; $i -lt 4; $i++) {
    $keep = [Math]::Max(0, [Math]::Min(8, $bits - 8 * $i))
    $mask = if ($keep -eq 0) { 0 } else { (0xFF -shl (8 - $keep)) -band 0xFF }
    $net[$i] = $addr[$i] -band $mask
  }
  return "$(([System.Net.IPAddress]::new($net)).ToString())/$bits"
}

# Windows returns the scope as 100.64.0.0/255.192.0.0 (mask form); normalise to a.b.c.d/prefix.
function Normalize-Remote([string]$a) {
  if ($a -match '^(\d+(?:\.\d+){3})/(\d+(?:\.\d+){3})$') {
    $bits = 0
    foreach ($o in $Matches[2].Split('.')) {
      $v = [int]$o
      while ($v -gt 0) { $bits += ($v -band 1); $v = $v -shr 1 }
    }
    return "$($Matches[1])/$bits"
  }
  return $a
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
    $norm = @($addr | ForEach-Object { Normalize-Remote ([string]$_) }) -join ","
    if ((Test-WslRule $r) -and $norm -ne $TailnetRange -and $norm -notmatch '^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.') {
      Write-Warning "  wsl rule remote address $norm is not a private NAT subnet - this rule may be reachable from outside the laptop."
    } elseif (Test-WslRule $r) {
      # scoped to the WSL subnet: expected to differ from the tailnet range
    } elseif ($norm -ne $TailnetRange) {
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
  if ($Wsl) { $rules = @($rules | Where-Object { Test-WslRule $_ }) }
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
# Each scope replaces only its own pair (-Wsl never touches the tailnet rules and vice versa).
foreach ($r in Get-OurRules) { if ([bool]$Wsl -eq [bool](Test-WslRule $r)) { $r | Remove-NetFirewallRule } }

if ($Wsl) {
  $wslIf = Get-WslAdapter
  $subnet = Resolve-WslSubnet $wslIf
  if (-not $subnet) {
    Write-Host "No 'vEthernet (WSL*)' adapter found (start a distro first, or pass -WslSubnet a.b.c.d/n). Nothing was added."
    exit 4
  }
  foreach ($spec in @(@{ Kind = "fleet"; Port = $ports.Fleet }, @{ Kind = "git"; Port = $ports.Git })) {
    $ruleArgs = @{
      DisplayName   = "$RulePrefix wsl $($spec.Kind) $($spec.Port)"
      Description   = "agentic-kanban $($spec.Kind) listener, WSL vEthernet subnet only (#1378). Do not widen."
      Direction     = "Inbound"
      Action        = "Allow"
      Protocol      = "TCP"
      LocalPort     = $spec.Port
      RemoteAddress = $subnet
      Profile       = "Any"
    }
    if ($wslIf) { $ruleArgs.InterfaceAlias = $wslIf.Name }
    New-NetFirewallRule @ruleArgs | Out-Null
    Write-Host "Added '$($ruleArgs.DisplayName)' (remote $subnet$(if ($wslIf) { ", interface $($wslIf.Name)" }))"
  }
  exit 0
}

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
  New-NetFirewallRule @ruleArgs | Out-Null
  Write-Host "Added '$($ruleArgs.DisplayName)' (remote $TailnetRange$(if ($ts) { ", interface $($ts.Name)" }))"
}
if (-not $ts) { Write-Host "No Tailscale interface found; rules are restricted by remote address only." }


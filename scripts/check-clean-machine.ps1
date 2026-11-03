[CmdletBinding()]
param(
    [switch]$Json,
    [switch]$RequireClean,
    [string[]]$TapTapPath = @()
)

$ErrorActionPreference = 'Stop'

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$devTools = @('node', 'npm', 'cargo', 'rustc', 'python', 'py', 'openssl', 'git') |
    Where-Object { Test-Command $_ }
$vmManagement = [ordered]@{
    HyperVGetVM     = Test-Command 'Get-VM'
    VirtualBox      = Test-Command 'VBoxManage'
    VMware          = Test-Command 'vmrun'
    WindowsSandbox  = Test-Path -LiteralPath 'C:\Windows\System32\WindowsSandbox.exe'
}
$vmModel = ("{0} {1}" -f $cs.Manufacturer, $cs.Model)
$looksLikeVm = $vmModel -match '(?i)virtual|vmware|virtualbox|qemu|kvm|xen|hyper-v'

if ($TapTapPath.Count -eq 0 -and $env:HEARTOPIA_TAPTAP_PATHS) {
    $TapTapPath = @(
        $env:HEARTOPIA_TAPTAP_PATHS -split ';' |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ }
    )
}

$tapTapCandidates = [System.Collections.Generic.List[string]]::new()
if ($TapTapPath.Count -gt 0) {
    foreach ($candidate in $TapTapPath) { $tapTapCandidates.Add($candidate) }
} else {
    if ($env:LOCALAPPDATA) { $tapTapCandidates.Add((Join-Path $env:LOCALAPPDATA 'TapTap')) }
    if ($env:ProgramFiles) { $tapTapCandidates.Add((Join-Path $env:ProgramFiles 'TapTap')) }
    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($programFilesX86) { $tapTapCandidates.Add((Join-Path $programFilesX86 'TapTap')) }
    $tapTapCandidates.Add('C:\TapTap')
}

$tapTapPresent = @(
    $tapTapCandidates | Where-Object { Test-Path -LiteralPath $_ }
).Count -gt 0
$gamePresent = @(
    $tapTapCandidates |
        ForEach-Object { Join-Path $_ 'PC Games\Heartopia' } |
        Where-Object { Test-Path -LiteralPath $_ }
).Count -gt 0
$tapTapCheck = if ($TapTapPath.Count -gt 0) { 'explicit' } else { 'standard-locations' }
$is64 = $os.OSArchitecture -match '64'
$build = [int]$os.BuildNumber
$supportedWindows = ($build -ge 19045) -or ($build -ge 22000)

$blockers = [System.Collections.Generic.List[string]]::new()
if (-not $is64) { $blockers.Add('OS is not x64') }
if (-not $supportedWindows) { $blockers.Add('OS build is outside Windows 10 22H2 / Windows 11 range') }
if ($devTools.Count -gt 0) { $blockers.Add('developer tools are installed') }
if ($tapTapPresent -or $gamePresent) { $blockers.Add('TapTap/game installation is present') }
if ($looksLikeVm) { $blockers.Add('machine model looks like a VM; snapshot provenance must be recorded') }

$status = if ($blockers.Count -eq 0) { 'CANDIDATE' } else { 'UNSUPPORTED' }
$windowsFamily = if ($build -ge 22000) {
    'Windows 11'
} elseif ($build -ge 19045) {
    'Windows 10 22H2'
} else {
    'unsupported'
}
$proofNote = 'clean-machine proof requires external hypervisor snapshot/device provenance; this script cannot prove it'
$payload = [ordered]@{
    status          = $status
    proof           = $false
    reason          = if ($status -eq 'CANDIDATE') {
        'Candidate guest only; snapshot provenance and acceptance steps are still required.'
    } else {
        'No clean Windows 10/11 environment is available on this host; do not treat developer-host runs as clean-machine acceptance.'
    }
    checkedAt       = (Get-Date).ToUniversalTime().ToString('o')
    windowsFamily   = $windowsFamily
    architecture    = $os.OSArchitecture
    hypervisor      = [bool]$cs.HypervisorPresent
    vmModel         = $looksLikeVm
    vmManagement    = $vmManagement
    devToolsPresent = $devTools.Count -gt 0
    tapTapCheck      = $tapTapCheck
    tapTapPresent   = $tapTapPresent
    gamePresent     = $gamePresent
    blockers        = @($blockers)
    proofNote       = $proofNote
}

if ($Json) {
    $payload | ConvertTo-Json -Depth 5
}
else {
    Write-Output 'clean-machine: UNSUPPORTED'
    Write-Output ("- OS family: {0} {1}" -f $windowsFamily, $os.OSArchitecture)
    Write-Output ("- HypervisorPresent: {0}; model looks like VM: {1}" -f $cs.HypervisorPresent, $looksLikeVm)
    Write-Output ("- VM tooling: Get-VM={0}, VBoxManage={1}, vmrun={2}, WindowsSandbox={3}" -f $vmManagement.HyperVGetVM, $vmManagement.VirtualBox, $vmManagement.VMware, $vmManagement.WindowsSandbox)
    Write-Output ("- developer tools present: {0}" -f ($devTools.Count -gt 0))
    Write-Output ("- TapTap present: {0}; game install present: {1}" -f $tapTapPresent, $gamePresent)
    Write-Output ('- proof: false; ' + $proofNote)
    Write-Output '- host model, exact OS build and tool names are intentionally omitted'
    foreach ($blocker in $blockers) { Write-Output ("- blocker: " + $blocker) }
}

if ($RequireClean) {
    Write-Output 'clean-machine: FAIL (cannot prove clean environment)'
    exit 3
}
exit 0

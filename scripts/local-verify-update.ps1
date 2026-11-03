<#
.SYNOPSIS
    Headless acceptance for the Tauri updater signature chain.

.DESCRIPTION
    Runs the `verify_update` example against a real NSIS package and its `.sig`.
    The example uses tauri-plugin-updater's authoritative `Update::verify`
    (minisign + signed version) and checks four cases:

      * the untouched package is accepted;
      * a package with one flipped byte is rejected;
      * a structurally valid but altered signature is rejected;
      * a manifest version that does not match the signed version is rejected.

    Nothing is installed, no window is created, and the package is never
    modified. Output contains stable status lines only: no paths, hashes,
    signatures, keys, or raw error text.

    Tauri examples are linked without the application manifest that the main
    binary gets from tauri-build. Windows then loads Common Controls v5 and the
    process fails before `main` because `TaskDialogIndirect` is v6-only. The
    script therefore copies the manifest resource from the built main binary
    into the example with `mt.exe` (Windows SDK, build-time only) before
    running it. The main binary itself is never started.

.PARAMETER Package
    Release installer. Defaults to the local NSIS bundle.

.PARAMETER Signature
    Detached `.sig` produced by the release build. Defaults to `<Package>.sig`.

.PARAMETER Manifest
    Release manifest JSON. Defaults to the local 0.1.0 artifact.

.PARAMETER CargoManifest
    Path to `src-tauri/Cargo.toml`. Defaults to the repository layout.
#>
[CmdletBinding()]
param(
    [string]$Package = '',
    [string]$Signature = '',
    [string]$Manifest = '',
    [string]$CargoManifest = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $CargoManifest) {
    $CargoManifest = Join-Path $repoRoot 'src-tauri\Cargo.toml'
}
if (-not $Package) {
    $Package = Join-Path $repoRoot 'src-tauri\target\release\bundle\nsis\Heartopia Photo Tool_0.1.0_x64-setup.exe'
}
if (-not $Signature) {
    $Signature = "$Package.sig"
}
if (-not $Manifest) {
    $Manifest = Join-Path $repoRoot 'artifacts\release\0.1.0\latest.json'
}

function Stop-Acceptance([string]$Code) {
    Write-Output 'update-signature-acceptance: FAIL'
    Write-Output "reason=$Code"
    exit 1
}

foreach ($path in @($Package, $Signature, $Manifest, $CargoManifest)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Stop-Acceptance 'input_missing'
    }
}

if ((Get-Item -LiteralPath $Package).Length -lt 1024) {
    Stop-Acceptance 'package_too_small'
}

$before = (Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash

$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& cargo build --quiet --manifest-path $CargoManifest --bin heartopia-photo-tool --example verify_update 2>&1 | Out-Null
$buildExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorAction
if ($buildExit -ne 0) {
    Stop-Acceptance 'harness_build'
}

$targetRoot = Join-Path $repoRoot 'src-tauri\target\debug'
$mainExe = Join-Path $targetRoot 'heartopia-photo-tool.exe'
$exampleExe = Join-Path $targetRoot 'examples\verify_update.exe'
if (-not (Test-Path -LiteralPath $mainExe -PathType Leaf) -or
    -not (Test-Path -LiteralPath $exampleExe -PathType Leaf)) {
    Stop-Acceptance 'harness_binary_missing'
}

$mt = Get-Command mt.exe -ErrorAction SilentlyContinue
if (-not $mt) {
    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    )
    $mt = Get-ChildItem -Path $roots -Recurse -Filter mt.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\mt\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
}
if (-not $mt) {
    Stop-Acceptance 'manifest_tool_missing'
}
$mtPath = if ($mt -is [System.Management.Automation.CommandInfo]) { $mt.Source } else { $mt.FullName }

$tempManifest = Join-Path ([IO.Path]::GetTempPath()) ("heartopia-manifest-" + [guid]::NewGuid().ToString('N') + ".manifest")
try {
    & $mtPath -nologo "-inputresource:$mainExe;#1" "-out:$tempManifest" | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tempManifest -PathType Leaf)) {
        Stop-Acceptance 'manifest_extract'
    }
    & $mtPath -nologo -manifest $tempManifest "-outputresource:$exampleExe;#1" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-Acceptance 'manifest_embed'
    }
}
finally {
    Remove-Item -LiteralPath $tempManifest -Force -ErrorAction SilentlyContinue
}

$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$output = & $exampleExe --package $Package --signature $Signature --manifest $Manifest 2>&1
$cargoExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorAction

$jsonLine = $output |
    Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') } |
    Select-Object -Last 1

if (-not $jsonLine) {
    Stop-Acceptance 'harness_failed'
}

try {
    $result = $jsonLine | ConvertFrom-Json
}
catch {
    Stop-Acceptance 'harness_output'
}

if ($result.status -ne 'pass') {
    $reason = [string]$result.code
    if (-not $reason) {
        $reason = 'harness_failed'
    }
    Stop-Acceptance $reason
}

if ($cargoExit -ne 0) {
    Stop-Acceptance 'harness_failed'
}

$after = (Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash
if ($before -ne $after) {
    Stop-Acceptance 'package_modified'
}

Write-Output 'update-signature-acceptance: PASS'
Write-Output ("valid-package=" + $result.checks.valid_package)
Write-Output ("tampered-package=" + $result.checks.tampered_package)
Write-Output ("tampered-signature=" + $result.checks.tampered_signature)
Write-Output ("version-mismatch=" + $result.checks.version_mismatch)
Write-Output 'package-unchanged=true'

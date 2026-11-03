param(
    [string]$InputRoot,
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not $InputRoot) {
    $InputRoot = Join-Path $env:USERPROFILE 'AppData\LocalLow\xd\心动小镇\ScreenCapture'
}
$runId = "{0}-{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmssfff'), $PID
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $projectRoot ".local\acceptance-output\$runId"
}
$workRoot = Join-Path $projectRoot ".local\acceptance-fixtures\$runId"

$cryptoFile = Join-Path $projectRoot '.secrets\crypto.dpapi'
if (-not (Test-Path -LiteralPath $cryptoFile -PathType Leaf)) {
    Write-Error 'Local crypto material is not prepared.' -ErrorAction Continue
    exit 3
}
if (-not (Test-Path -LiteralPath $InputRoot -PathType Container)) {
    Write-Error 'Input directory was not found.' -ErrorAction Continue
    exit 4
}

$plain = $null
Push-Location $projectRoot
try {
    $plain = [Security.Cryptography.ProtectedData]::Unprotect(
        [IO.File]::ReadAllBytes($cryptoFile), $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    if ($plain.Length -ne 48) {
        throw 'Invalid local crypto material.'
    }
    $env:HEARTOPIA_CRYPTO_MATERIAL_B64 = [Convert]::ToBase64String($plain)

    & cargo run --quiet --manifest-path (Join-Path $projectRoot 'src-tauri\Cargo.toml') `
        --example acceptance -- --input $InputRoot --output $OutputRoot --work $workRoot
    $code = $LASTEXITCODE
}
catch {
    # Never print the exception: it may contain local paths.
    Write-Error 'Native acceptance harness could not run.' -ErrorAction Continue
    $code = 5
}
finally {
    Pop-Location
    Remove-Item Env:HEARTOPIA_CRYPTO_MATERIAL_B64 -ErrorAction SilentlyContinue
    if ($null -ne $plain) {
        [Array]::Clear($plain, 0, $plain.Length)
    }
    $plain = $null
}

exit $code

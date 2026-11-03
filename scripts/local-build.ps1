param(
    [ValidateSet('build', 'dev', 'test')][string]$Mode = 'build',
    [string]$Config,
    [switch]$DebugBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$private = Join-Path $root '.secrets'
$protectedFile = Join-Path $private 'crypto.dpapi'
if (-not (Test-Path -LiteralPath $protectedFile)) { throw 'Prepare local build secrets before using this helper.' }
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
    [IO.File]::ReadAllBytes($protectedFile), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
)
if ($plain.Length -ne 48) { throw 'Invalid local crypto material.' }
$env:HEARTOPIA_CRYPTO_MATERIAL_B64 = [Convert]::ToBase64String($plain)
[Array]::Clear($plain, 0, $plain.Length)
$signingFile = Join-Path $private 'updater.key'
if (Test-Path -LiteralPath $signingFile) {
    $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($signingFile)
    $passwordFile = Join-Path $private 'updater-password.dpapi'
    if (Test-Path -LiteralPath $passwordFile) {
        $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect(
            [IO.File]::ReadAllBytes($passwordFile), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Text.Encoding]::UTF8.GetString($passwordBytes)
        [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
    }
}
Push-Location $root
try {
    if ($Mode -eq 'test') {
        & cargo test --manifest-path src-tauri/Cargo.toml
    } else {
        $arguments = @('run', 'tauri', '--', $Mode)
        if ($Mode -eq 'build') { $env:HEARTOPIA_RELEASE = '1' }
        if ($DebugBuild) { $arguments += '--debug' }
        if ($Config) { $arguments += @('--config', $Config) }
        & npm @arguments
    }
    if ($LASTEXITCODE -ne 0) { throw 'Native command failed; see the sanitized build diagnostics above.' }
} finally {
    Pop-Location
    Remove-Item Env:HEARTOPIA_CRYPTO_MATERIAL_B64 -ErrorAction SilentlyContinue
    Remove-Item Env:HEARTOPIA_RELEASE -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

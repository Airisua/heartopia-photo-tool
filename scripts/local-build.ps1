param(
    [ValidateSet('build', 'dev', 'test')][string]$Mode = 'build',
    [string]$Config,
    [string]$DownloadProxy,
    [switch]$DebugBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$private = Join-Path $root '.secrets'
$protectedFile = Join-Path $private 'crypto.dpapi'
$plain = $null
$passwordBytes = $null
$pushed = $false
$proxyChanged = $false
$previousHttpProxy = [Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process')
$previousHttpsProxy = [Environment]::GetEnvironmentVariable('HTTPS_PROXY', 'Process')
$secretNames = @('HEARTOPIA_CRYPTO_MATERIAL_B64','HEARTOPIA_RELEASE','TAURI_SIGNING_PRIVATE_KEY','TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
try {
    foreach ($name in $secretNames) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    . (Join-Path $PSScriptRoot 'lib\local-dpapi.ps1')
    Initialize-LocalDpapi
    if (-not (Test-Path -LiteralPath $protectedFile -PathType Leaf)) {
        throw 'Prepare local build secrets before using this helper.'
    }
    $signingFile = Join-Path $private 'updater.key'
    if ($Mode -eq 'build' -and -not (Test-Path -LiteralPath $signingFile -PathType Leaf)) {
        throw 'Prepare the updater signing key before building a release.'
    }
    Push-Location $root
    $pushed = $true

    $buildConfig = $null
    if ($Mode -eq 'build') {
        # Frontend tools never receive either the AES material or signing key.
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend production build failed.' }
        $configDir = Join-Path $root '.local\build'
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
        $buildConfig = Join-Path $configDir ('release-hooks-'+$PID+'.json')
        [IO.File]::WriteAllText($buildConfig, '{"build":{"beforeBuildCommand":null,"beforeBundleCommand":null}}')
    }

    $plain = [Security.Cryptography.ProtectedData]::Unprotect(
        [IO.File]::ReadAllBytes($protectedFile), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    if ($plain.Length -ne 48) { throw 'Invalid local crypto material.' }
    $env:HEARTOPIA_CRYPTO_MATERIAL_B64 = [Convert]::ToBase64String($plain)
    [Array]::Clear($plain, 0, $plain.Length)

    if ($Mode -eq 'test') {
        & cargo test --manifest-path crates/photo-core/Cargo.toml --locked
        if ($LASTEXITCODE -ne 0) { throw 'Core tests failed.' }
        & cargo test --manifest-path src-tauri/Cargo.toml --locked
    } elseif ($Mode -eq 'build') {
        $env:HEARTOPIA_RELEASE = '1'
        & node scripts/verify-crypto-material.mjs --require
        if ($LASTEXITCODE -ne 0) { throw 'Release crypto preflight failed.' }
        & node scripts/preflight-release.mjs --release
        if ($LASTEXITCODE -ne 0) { throw 'Release configuration preflight failed.' }

        $arguments = @('run','tauri','--','build','--no-bundle','--ci')
        if ($DebugBuild) { $arguments += '--debug' }
        if ($Config) { $arguments += @('--config',$Config) }
        $arguments += @('--config',$buildConfig)
        & npm @arguments
        if ($LASTEXITCODE -ne 0) { throw 'Native release compilation failed.' }
        Remove-Item Env:HEARTOPIA_CRYPTO_MATERIAL_B64,Env:HEARTOPIA_RELEASE -ErrorAction SilentlyContinue

        # Only the bundler sees the signing key; Cargo and build scripts do not.
        $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($signingFile)
        if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) { throw 'Updater signing key is empty.' }
        $passwordFile = Join-Path $private 'updater-password.dpapi'
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
        if (Test-Path -LiteralPath $passwordFile -PathType Leaf) {
            $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect(
                [IO.File]::ReadAllBytes($passwordFile), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
            )
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Text.Encoding]::UTF8.GetString($passwordBytes)
            [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
        }
        if ($DownloadProxy) {
            $proxyUri = $null
            if (-not [Uri]::TryCreate($DownloadProxy, [UriKind]::Absolute, [ref]$proxyUri) -or
                $proxyUri.Scheme -notin @('http', 'https')) {
                throw 'Download proxy must be an absolute HTTP or HTTPS URL.'
            }
            $env:HTTP_PROXY = $DownloadProxy
            $env:HTTPS_PROXY = $DownloadProxy
            $proxyChanged = $true
        }
        $arguments = @('run','tauri','--','bundle','--bundles','nsis','--ci')
        if ($DebugBuild) { $arguments += '--debug' }
        if ($Config) { $arguments += @('--config',$Config) }
        $arguments += @('--config',$buildConfig)
        & npm @arguments
        if ($LASTEXITCODE -ne 0) { throw 'Release bundle or signing failed.' }
        Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY,Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
        $profile = if ($DebugBuild) { 'debug' } else { 'release' }
        # Keep previously built versions intact. Validate a fresh staging directory
        # containing exactly the current version, not a shared multi-version cache.
        $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
        $bundleDir = Join-Path $root "src-tauri\target\$profile\bundle\nsis"
        $suffix = "_${version}_x64-setup.exe"
        $current = @(Get-ChildItem -LiteralPath $bundleDir -File | Where-Object {
            $_.Name.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($current.Count -ne 1) { throw 'Expected exactly one installer for the current version.' }
        $signature = $current[0].FullName + '.sig'
        if (-not (Test-Path -LiteralPath $signature -PathType Leaf)) { throw 'Current updater signature is missing.' }
        $verifiedDir = Join-Path $root ('.local\build\current-package-' + $version + '-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $verifiedDir -Force | Out-Null
        Copy-Item -LiteralPath $current[0].FullName -Destination (Join-Path $verifiedDir $current[0].Name)
        Copy-Item -LiteralPath $signature -Destination (Join-Path $verifiedDir ($current[0].Name + '.sig'))
        & node scripts/verify-release-artifacts.mjs --bundle-dir $verifiedDir --version $version
    } else {
        $arguments = @('run', 'tauri', '--', $Mode)
        if ($DebugBuild) { $arguments += '--debug' }
        if ($Config) { $arguments += @('--config', $Config) }
        & npm @arguments
    }
    if ($LASTEXITCODE -ne 0) { throw 'Native command failed; see the sanitized build diagnostics above.' }
} finally {
    if ($pushed) { Pop-Location }
    foreach ($name in $secretNames) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) }
    if ($null -ne $passwordBytes) { [Array]::Clear($passwordBytes,0,$passwordBytes.Length) }
    if ($proxyChanged) {
        [Environment]::SetEnvironmentVariable('HTTP_PROXY', $previousHttpProxy, 'Process')
        [Environment]::SetEnvironmentVariable('HTTPS_PROXY', $previousHttpsProxy, 'Process')
    }
}

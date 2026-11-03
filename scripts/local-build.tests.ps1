# Synthetic regression checks for the local build helper, not application acceptance.
# No game material, real signing key, compiler or installer is used.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $repo ('.local\build-helper-tests\' + [guid]::NewGuid().ToString('N'))
$scripts = Join-Path $fixture 'scripts'
$private = Join-Path $fixture '.secrets'
New-Item -ItemType Directory -Path $scripts, $private -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local-build.ps1') -Destination $scripts
$dpapi = Join-Path $PSScriptRoot 'lib\local-dpapi.ps1'
if (Test-Path -LiteralPath $dpapi) {
    New-Item -ItemType Directory -Path (Join-Path $scripts 'lib') -Force | Out-Null
    Copy-Item -LiteralPath $dpapi -Destination (Join-Path $scripts 'lib')
}
if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
    Add-Type -AssemblyName System.Security
}
$synthetic = [byte[]](0..47)
try {
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
        $synthetic, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [IO.File]::WriteAllBytes((Join-Path $private 'crypto.dpapi'), $protected)
} finally {
    [Array]::Clear($synthetic, 0, $synthetic.Length)
}
[IO.File]::WriteAllText((Join-Path $private 'updater.key'), 'SYNTHETIC_TEST_KEY_NOT_A_SIGNING_KEY')
[IO.File]::WriteAllText((Join-Path $fixture 'package.json'), '{"version":"9.9.9"}')
$bundle = Join-Path $fixture 'src-tauri\target\release\bundle\nsis'
New-Item -ItemType Directory -Path $bundle -Force | Out-Null
$old = Join-Path $bundle 'Fixture_9.9.8_x64-setup.exe'
[IO.File]::WriteAllText($old, 'synthetic-old-package')
[IO.File]::WriteAllText(($old + '.sig'), 'synthetic-old-signature')
$oldHash = (Get-FileHash -LiteralPath $old -Algorithm SHA256).Hash
$oldSigHash = (Get-FileHash -LiteralPath ($old + '.sig') -Algorithm SHA256).Hash
$global:BuildHelperFixture = @{ bundle = $bundle; stages = @(); checked = $false }

function npm {
    $argv = @($args)
    if ($argv -contains 'bundle') {
        if ($env:HEARTOPIA_CRYPTO_MATERIAL_B64 -or $env:HEARTOPIA_RELEASE) { throw 'bundle_received_crypto' }
        if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { throw 'bundle_missing_signing' }
        $global:BuildHelperFixture.stages += 'bundle'
        $current = Join-Path $global:BuildHelperFixture.bundle 'Fixture_9.9.9_x64-setup.exe'
        [IO.File]::WriteAllText($current, 'synthetic-current-package')
        [IO.File]::WriteAllText(($current + '.sig'), 'synthetic-current-signature')
    } elseif ($argv -contains 'tauri') {
        if (-not $env:HEARTOPIA_CRYPTO_MATERIAL_B64) { throw 'compile_missing_crypto' }
        if ($env:TAURI_SIGNING_PRIVATE_KEY -or $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { throw 'compile_received_signing' }
        $global:BuildHelperFixture.stages += 'compile'
    } else {
        if ($env:HEARTOPIA_CRYPTO_MATERIAL_B64 -or $env:TAURI_SIGNING_PRIVATE_KEY) { throw 'frontend_received_secret' }
        $global:BuildHelperFixture.stages += 'frontend'
    }
    $global:LASTEXITCODE = 0
}

function node {
    $argv = @($args)
    if ($argv[0] -eq 'scripts/verify-release-artifacts.mjs') {
        $index = [Array]::IndexOf($argv, '--bundle-dir')
        $target = $argv[$index + 1]
        $setups = @(Get-ChildItem -LiteralPath $target -File | Where-Object { $_.Name -match '-setup\.exe$' })
        if ($setups.Count -ne 1 -or $setups[0].Name -ne 'Fixture_9.9.9_x64-setup.exe') {
            $global:LASTEXITCODE = 1
            return
        }
        $global:BuildHelperFixture.checked = $true
    }
    $global:LASTEXITCODE = 0
}

$failures = [Collections.Generic.List[string]]::new()
$oldHttp = $env:HTTP_PROXY
$oldHttps = $env:HTTPS_PROXY
try {
    & (Join-Path $scripts 'local-build.ps1') -Mode build -DownloadProxy 'http://127.0.0.1:9'
    if (-not $global:BuildHelperFixture.checked) { $failures.Add('current_bundle_not_verified') }
    if (($global:BuildHelperFixture.stages -join ',') -ne 'frontend,compile,bundle') { $failures.Add('stage_order') }
} catch {
    $failures.Add('build_helper_failed')
}
if ((Get-FileHash -LiteralPath $old).Hash -ne $oldHash -or
    (Get-FileHash -LiteralPath ($old + '.sig')).Hash -ne $oldSigHash) { $failures.Add('old_bundle_modified') }
foreach ($name in @('HEARTOPIA_CRYPTO_MATERIAL_B64', 'HEARTOPIA_RELEASE', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) { $failures.Add('secret_not_cleared') }
}
if ([string]$env:HTTP_PROXY -ne [string]$oldHttp -or [string]$env:HTTPS_PROXY -ne [string]$oldHttps) { $failures.Add('proxy_not_restored') }

# A fresh Windows PowerShell 5.1 process does not preload the DPAPI assembly.
# Stub Cargo, so this checks helper initialization and cleanup without compiling.
$legacy = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$helper = (Join-Path $scripts 'local-build.ps1').Replace("'", "''")
$child = @"
`$ErrorActionPreference = 'Stop'
function cargo { if (-not `$env:HEARTOPIA_CRYPTO_MATERIAL_B64 -or `$env:TAURI_SIGNING_PRIVATE_KEY) { throw 'invalid_test_environment' }; `$global:LASTEXITCODE = 0 }
try { & '$helper' -Mode test; if (`$env:HEARTOPIA_CRYPTO_MATERIAL_B64) { exit 2 }; exit 0 } catch { exit 1 }
"@
if (Test-Path -LiteralPath $legacy) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
    & $legacy -NoProfile -NonInteractive -EncodedCommand $encoded *> $null
    if ($LASTEXITCODE -ne 0) { $failures.Add('fresh_windows_powershell_dpapi') }
} else {
    $failures.Add('windows_powershell_missing')
}
Remove-Variable BuildHelperFixture -Scope Global -ErrorAction SilentlyContinue
if ($failures.Count -gt 0) {
    Write-Output 'local-build-helper-tests: FAIL'
    $failures | Sort-Object -Unique | ForEach-Object { Write-Output ('reason=' + $_) }
    exit 1
}
Write-Output 'local-build-helper-tests: PASS'
Write-Output 'fresh-windows-powershell-dpapi=true'
Write-Output 'current-bundle-only=true'
Write-Output 'old-bundle-unchanged=true'
Write-Output 'secret-stage-isolation=true'
Write-Output 'secret-cleanup=true'
Write-Output 'proxy-restored=true'

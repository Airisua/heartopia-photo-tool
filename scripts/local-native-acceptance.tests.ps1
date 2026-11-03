# Small CLI guard tests for the native acceptance example.
# All synthetic fixtures live under .local; the game input is never used.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $projectRoot 'src-tauri\Cargo.toml'
$exe = Join-Path $projectRoot 'src-tauri\target\debug\examples\acceptance.exe'
$runId = "{0}-{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmssfff'), $PID
$root = Join-Path $projectRoot ".local\acceptance-fixtures\cli-work-guard-$runId"
$previousRelease = $env:HEARTOPIA_RELEASE
$script:failed = $false

function Get-TreeFingerprint([string]$treeRoot) {
    $resolved = (Resolve-Path -LiteralPath $treeRoot).Path
    $builder = [Text.StringBuilder]::new()
    $items = Get-ChildItem -LiteralPath $resolved -Recurse -Force | Sort-Object FullName
    foreach ($item in $items) {
        $relative = $item.FullName.Substring($resolved.Length).TrimStart('\')
        if ($item.PSIsContainer) {
            [void]$builder.Append("D|$relative`n")
        }
        else {
            [void]$builder.Append("F|$relative|$($item.Length)|$($item.LastWriteTimeUtc.Ticks)`n")
        }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return [Convert]::ToBase64String(
            $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($builder.ToString()))
        )
    }
    finally {
        $sha.Dispose()
    }
}

function Invoke-CliCase([string]$name, [string]$work, [string]$expected) {
    $before = Get-TreeFingerprint $screen
    $stdoutFile = Join-Path $root "$name.stdout"
    $stderrFile = Join-Path $root "$name.stderr"
    & $exe --input $inputRoot --output $output --work $work > $stdoutFile 2> $stderrFile
    $exitCode = $LASTEXITCODE
    $after = Get-TreeFingerprint $screen
    $stdoutText = if (Test-Path -LiteralPath $stdoutFile) {
        Get-Content -LiteralPath $stdoutFile -Raw
    }
    else {
        ''
    }
    $stderrText = if (Test-Path -LiteralPath $stderrFile) {
        Get-Content -LiteralPath $stderrFile -Raw
    }
    else {
        ''
    }
    $combined = "$stdoutText`n$stderrText"
    $json = $null
    try {
        $json = $stdoutText | ConvertFrom-Json
    }
    catch {
    }
    $actual = if ($json -and ($json.PSObject.Properties.Name -contains 'error')) {
        [string]$json.error
    }
    else {
        'unexpected-output'
    }
    $status = if ($json -and ($json.PSObject.Properties.Name -contains 'status')) {
        [string]$json.status
    }
    else {
        'invalid'
    }
    $leaked = $false
    foreach ($candidate in @($inputRoot, $root, $output)) {
        if ($candidate -and $combined.Contains($candidate)) {
            $leaked = $true
        }
    }
    $unchanged = $before -eq $after
    $ok = ($exitCode -ne 0) -and ($status -eq 'error') -and ($actual -eq $expected) -and $unchanged -and (-not $leaked)
    Write-Output ("case={0} expected={1} actual={2} exit={3} inputUnchanged={4} pathLeak={5}" -f $name, $expected, $actual, $exitCode, $unchanged, $leaked)
    if (-not $ok) {
        $script:failed = $true
    }
}

try {
    Remove-Item Env:HEARTOPIA_RELEASE -ErrorAction SilentlyContinue
    & cargo build --quiet --locked --manifest-path $manifest --example acceptance *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Output 'build-failed'
        exit 1
    }
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        Write-Output 'binary-missing'
        exit 1
    }

    $screen = Join-Path $root 'ScreenCapture'
    $inputRoot = Join-Path $screen 'Photo'
    $inside = Join-Path $inputRoot 'inside'
    $gameSibling = Join-Path $screen 'Announcement'
    $nonEmptyWork = Join-Path $root 'nonempty-work'
    $safeTarget = Join-Path $root 'safe-target'
    $workLink = Join-Path $root 'work-link'
    $output = Join-Path $root 'out'

    New-Item -ItemType Directory -Force -Path $inputRoot, $inside, $gameSibling, $nonEmptyWork, $safeTarget | Out-Null
    Set-Content -LiteralPath (Join-Path $inputRoot 'seed.bin') -Value 'seed' -NoNewline
    Set-Content -LiteralPath (Join-Path $nonEmptyWork 'keep.bin') -Value 'keep' -NoNewline
    & cmd.exe /c mklink /J $workLink $safeTarget *> $null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $workLink)) {
        Write-Output 'junction-setup-failed'
        exit 1
    }

    Invoke-CliCase 'work-equals-input' $inputRoot 'work_equals_input'
    Invoke-CliCase 'work-inside-input' $inside 'work_inside_input'
    Invoke-CliCase 'work-inside-game-tree' $gameSibling 'work_inside_game_tree'
    Invoke-CliCase 'work-junction' $workLink 'work_reparse'
    Invoke-CliCase 'work-nonempty' $nonEmptyWork 'work_not_empty'
    Invoke-CliCase 'work-contains-input' $root 'work_contains_input'

    if ($script:failed) {
        Write-Output 'result=FAIL'
        exit 1
    }
    Write-Output 'result=PASS'
    exit 0
}
finally {
    if ($null -ne $previousRelease) {
        $env:HEARTOPIA_RELEASE = $previousRelease
    }
    else {
        Remove-Item Env:HEARTOPIA_RELEASE -ErrorAction SilentlyContinue
    }
}

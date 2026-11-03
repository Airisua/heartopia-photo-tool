[CmdletBinding()]
param(
    [string[]]$Path = @(),
    [Parameter(Mandatory = $true)]
    [ValidateSet('snapshot', 'compare')]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [string]$Record,
    [switch]$Hash
)

$ErrorActionPreference = 'Stop'

if ($Path.Count -eq 0 -and $env:HEARTOPIA_PROTECTED_PATHS) {
    $Path = @(
        $env:HEARTOPIA_PROTECTED_PATHS -split ';' |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ }
    )
}
if ($Path.Count -eq 0) {
    throw '请通过 -Path 或 HEARTOPIA_PROTECTED_PATHS 指定受保护目录；脚本不内置本机路径。'
}

$recordFull = [System.IO.Path]::GetFullPath($Record)

function Test-IsInside {
    param([string]$Child, [string]$Parent)
    $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\')
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
    return $childFull.Equals($parentFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $childFull.StartsWith($parentFull + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

foreach ($root in $Path) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "受保护目录不存在: $root"
    }
    if (Test-IsInside -Child $recordFull -Parent $root) {
        throw "记录文件不能写入受保护目录内部: $Record"
    }
}

$recordDir = Split-Path -Parent $recordFull
if ($recordDir -and -not (Test-Path -LiteralPath $recordDir -PathType Container)) {
    New-Item -ItemType Directory -Path $recordDir -Force | Out-Null
}

function Get-FileSha256 {
    param([string]$File)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::Open($File, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $sha.Dispose()
    }
}

function Get-Snapshot {
    $entries = [System.Collections.Generic.List[object]]::new()
    $rootIndex = 0
    foreach ($root in $Path) {
        $rootItem = Get-Item -LiteralPath $root -Force
        Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue |
            ForEach-Object {
                $relative = $_.FullName.Substring($rootItem.FullName.Length).TrimStart('\')
                $item = [ordered]@{
                    rootIndex       = $rootIndex
                    root            = $rootItem.Name
                    relative        = $relative
                    length          = $_.Length
                    modifiedUtc     = $_.LastWriteTimeUtc.ToString('o')
                    modifiedUtcTicks = $_.LastWriteTimeUtc.Ticks
                }
                if ($Hash) {
                    $item.sha256 = Get-FileSha256 -File $_.FullName
                }
                $entries.Add([pscustomobject]$item)
            }
        $rootIndex++
    }
    return $entries
}

if ($Mode -eq 'snapshot') {
    $entries = Get-Snapshot
    $entryMap = [ordered]@{}
    foreach ($entry in $entries) {
        $entryMap["$($entry.rootIndex)|$($entry.relative)"] = $entry
    }
    $payload = [ordered]@{
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        hashed    = [bool]$Hash
        rootCount = $Path.Count
        fileCount = $entries.Count
        entries   = $entryMap
    }
    $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $recordFull -Encoding UTF8
    Write-Output ("protected paths: snapshot PASS ({0} files, hash={1})" -f $entries.Count, [bool]$Hash)
    exit 0
}

if (-not (Test-Path -LiteralPath $recordFull -PathType Leaf)) {
    throw "快照不存在: $Record"
}

$before = Get-Content -LiteralPath $recordFull -Raw -Encoding UTF8 | ConvertFrom-Json
if ([bool]$before.hashed -ne [bool]$Hash) {
    throw "快照的 hash 模式与当前 -Hash 参数不一致"
}

$beforeMap = @{}
foreach ($property in $before.entries.PSObject.Properties) {
    $beforeMap[$property.Name] = $property.Value
}

$after = Get-Snapshot
$afterMap = @{}
foreach ($entry in $after) {
    $afterMap["$($entry.rootIndex)|$($entry.relative)"] = $entry
}

$added = @($afterMap.Keys | Where-Object { -not $beforeMap.ContainsKey($_) })
$removed = @($beforeMap.Keys | Where-Object { -not $afterMap.ContainsKey($_) })
$changed = @()
foreach ($key in $afterMap.Keys) {
    if (-not $beforeMap.ContainsKey($key)) { continue }
    $a = $beforeMap[$key]
    $b = $afterMap[$key]
    if ([int64]$a.length -ne [int64]$b.length -or [int64]$a.modifiedUtcTicks -ne [int64]$b.modifiedUtcTicks) {
        $changed += $key
    }
    elseif ($Hash -and $a.sha256 -ne $b.sha256) {
        $changed += $key
    }
}

$drift = $added.Count + $removed.Count + $changed.Count
if ($drift -gt 0) {
    Write-Output ("protected paths: FAIL (added={0}, removed={1}, changed={2})" -f $added.Count, $removed.Count, $changed.Count)
    @($added + $removed + $changed) | Select-Object -First 20 | ForEach-Object { Write-Output ("- " + $_) }
    exit 1
}

Write-Output ("protected paths: PASS ({0} files unchanged)" -f $after.Count)

param(
    [Parameter(Mandatory = $true)][string]$EncryptionSource
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$private = Join-Path $root '.secrets'
[IO.Directory]::CreateDirectory($private) | Out-Null
$source = [IO.File]::ReadAllText($EncryptionSource)
$material = [Collections.Generic.List[byte]]::new()
foreach ($name in @('KEY', 'IV')) {
    $pattern = 'private\s+static\s+byte\[\]\s+' + $name + '\s*=\s*new\s+byte\[\d+\]\s*\{(?<values>.*?)\}'
    $match = [regex]::Match($source, $pattern, [Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $match.Success) { throw 'Local encryption declaration was not found.' }
    [byte[]]$bytes = @([regex]::Matches($match.Groups['values'].Value, '\d+') | ForEach-Object { [byte]$_.Value })
    $expected = if ($name -eq 'KEY') { 32 } else { 16 }
    if ($bytes.Length -ne $expected) { throw 'Unexpected encryption material length.' }
    $material.AddRange($bytes)
    [Array]::Clear($bytes, 0, $bytes.Length)
}
$plain = $material.ToArray()
$protected = [Security.Cryptography.ProtectedData]::Protect(
    $plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[IO.File]::WriteAllBytes((Join-Path $private 'crypto.dpapi'), $protected)
[Array]::Clear($plain, 0, $plain.Length)
$material.Clear()
$source = $null
Write-Output 'Build-only crypto material stored using current-user DPAPI; no key values were displayed.'

<#
SYNOPSIS
  photo-sort step 3 (bulk apply): move root images into category folders
  according to a CSV verdict map. Source files only moved, never modified.
NOTES
  - Keep this file ASCII-only (see SKILL.md pitfall section).
  - CSV is read with explicit UTF8 so category names survive any codepage.
  - Category SKIP (ASCII uppercase) means cover-with-title: leave in place.
  - Name clash at destination: append _1, _2... never overwrite.
EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File skills/photo-sort/apply-moves.ps1
#>
param(
  [string]$Root = '.',
  [string]$Map = '.sort-cache/moves.csv'
)

$ErrorActionPreference = 'Stop'
$rootFull = (Resolve-Path -LiteralPath $Root).Path
$mapPath = Join-Path $rootFull $Map
$lines = Get-Content -LiteralPath $mapPath -Encoding UTF8 |
  Where-Object { $_.Trim() -ne '' }

$moved = 0; $skipped = 0; $renamed = 0; $missing = @(); $badcat = @()
foreach ($ln in $lines) {
  $i = $ln.IndexOf(',')
  if ($i -lt 1) { $badcat += $ln; continue }
  $name = $ln.Substring(0, $i).Trim()
  $cat = $ln.Substring($i + 1).Trim()
  if ($cat -eq 'SKIP') { $skipped++; continue }
  $src = Join-Path $rootFull $name
  if (-not (Test-Path -LiteralPath $src)) { $missing += $name; continue }
  $dir = Join-Path $rootFull $cat
  if (-not (Test-Path -LiteralPath $dir)) { $badcat += ($name + ' -> ' + $cat); continue }
  $dst = Join-Path $dir $name
  if (Test-Path -LiteralPath $dst) {
    $b = [System.IO.Path]::GetFileNameWithoutExtension($name)
    $e = [System.IO.Path]::GetExtension($name)
    $n = 1
    while (Test-Path -LiteralPath (Join-Path $dir ($b + '_' + $n + $e))) { $n++ }
    $dst = Join-Path $dir ($b + '_' + $n + $e)
    $renamed++
  }
  Move-Item -LiteralPath $src -Destination $dst
  $moved++
}

Write-Output ("lines=" + $lines.Count + " moved=" + $moved + " skipped=" + $skipped + " renamed=" + $renamed + " missing=" + $missing.Count + " badcat=" + $badcat.Count)
if ($missing.Count -gt 0) { Write-Output ('MISSING: ' + ($missing -join ' | ')) }
if ($badcat.Count -gt 0) { Write-Output ('BADCAT: ' + ($badcat -join ' | ')) }

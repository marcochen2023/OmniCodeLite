<#
SYNOPSIS
  photo-sort step 1 (preprocess): convert root-folder images to 600x900
  JPEG quality-90 previews for LLM classification. Source files untouched.
NOTES
  - Cover crop (center) to 2:3 first, then scale: no stretch, faces undistorted.
  - Idempotent: previews newer than source are skipped.
  - Only scans root files, so already-sorted images are never re-scanned.
  - Keep this file ASCII-only: Windows PowerShell 5.1 misparses UTF-8
    without BOM when CJK bytes are present (silently breaks array literals).
EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File skills/photo-sort/prep.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File skills/photo-sort/prep.ps1 -Src 'D:\pics' -Dst 'D:\pics\.sort-cache'
#>
param(
  [string]$Src = '.',
  [string]$Dst = '.sort-cache',
  [int]$Width = 600,
  [int]$Height = 900,
  [int]$Quality = 90
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$srcFull = (Resolve-Path -LiteralPath $Src).Path
if (-not (Test-Path -LiteralPath $Dst)) { New-Item -ItemType Directory -Path $Dst | Out-Null }
$dstFull = (Resolve-Path -LiteralPath $Dst).Path

# Formats GDI+ can decode natively. webp not guaranteed here; failures land in FAILED list.
$exts = @('.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tif', '.tiff')
$files = Get-ChildItem -LiteralPath $srcFull -File |
  Where-Object { $exts -contains $_.Extension.ToLower() }

$jpgCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
  [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

$done = 0; $skip = 0; $fail = @()
foreach ($f in $files) {
  $out = Join-Path $dstFull ($f.BaseName + '.jpg')
  if ((Test-Path -LiteralPath $out) -and
      ((Get-Item -LiteralPath $out).LastWriteTime -ge $f.LastWriteTime)) { $skip++; continue }
  try {
    $img = [System.Drawing.Image]::FromFile($f.FullName)
    try {
      $sw = $img.Width; $sh = $img.Height
      $tr = $Width / $Height
      $sr = $sw / [double]$sh
      if ($sr -gt $tr) {
        $cw = [int]($sh * $tr); $ch = $sh
        $cx = [int](($sw - $cw) / 2); $cy = 0
      } else {
        $cw = $sw; $ch = [int]($sw / $tr)
        $cx = 0; $cy = [int]($sh - $ch) / 2
      }
      $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear([System.Drawing.Color]::White)
        $g.DrawImage($img,
          (New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)),
          $cx, $cy, $cw, $ch, [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $g.Dispose() }
      $bmp.Save($out, $jpgCodec, $encParams)
      $bmp.Dispose()
      $done++
    } finally { $img.Dispose() }
  } catch {
    $fail += $f.Name
  }
}

Write-Output "total=$($files.Count) done=$done skip=$skip fail=$($fail.Count)"
if ($fail.Count -gt 0) { Write-Output ('FAILED: ' + ($fail -join ', ')) }

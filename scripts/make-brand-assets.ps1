# Derives right-sized brand images from the official WorkEasy360 artwork (the originals are left untouched).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File make-brand-assets.ps1 -Root C:\path\to\Booker
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bmp.SetResolution(96, 96)
  return $bmp
}

function Draw-Into($src, [System.Drawing.Rectangle]$srcRect, $dst, [System.Drawing.Rectangle]$dstRect, $background) {
  $g = [System.Drawing.Graphics]::FromImage($dst)
  try {
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    if ($background) { $g.Clear($background) } else { $g.Clear([System.Drawing.Color]::Transparent) }
    $attr = New-Object System.Drawing.Imaging.ImageAttributes
    $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $g.DrawImage($src, $dstRect, $srcRect.X, $srcRect.Y, $srcRect.Width, $srcRect.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
  } finally { $g.Dispose() }
}

# Bounding box of pixels that are not (almost) fully transparent.
function Get-AlphaBounds($bmp) {
  $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $bytes = New-Object byte[] ($data.Stride * $bmp.Height)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $stride = $data.Stride
  } finally { $bmp.UnlockBits($data) }
  $minX = $bmp.Width; $minY = $bmp.Height; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    $row = $y * $stride
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      if ($bytes[$row + $x * 4 + 3] -gt 8) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  return @{ X = $minX; Y = $minY; W = $maxX - $minX + 1; H = $maxY - $minY + 1 }
}

# The artwork's content rectangle in source pixels, found on a 1/20 probe and padded by one probe pixel.
function Get-ContentRect($src) {
  $scale = 20
  $pw = [Math]::Max(1, [int][Math]::Round($src.Width / $scale)); $ph = [Math]::Max(1, [int][Math]::Round($src.Height / $scale))
  $probe = New-Canvas $pw $ph
  try {
    Draw-Into $src (New-Object System.Drawing.Rectangle(0, 0, $src.Width, $src.Height)) $probe (New-Object System.Drawing.Rectangle(0, 0, $pw, $ph)) $null
    $b = Get-AlphaBounds $probe
  } finally { $probe.Dispose() }
  $sx = $src.Width / $pw; $sy = $src.Height / $ph
  $x0 = [Math]::Max(0, [int][Math]::Floor(($b.X - 1) * $sx)); $y0 = [Math]::Max(0, [int][Math]::Floor(($b.Y - 1) * $sy))
  $x1 = [Math]::Min($src.Width, [int][Math]::Ceiling(($b.X + $b.W + 1) * $sx)); $y1 = [Math]::Min($src.Height, [int][Math]::Ceiling(($b.Y + $b.H + 1) * $sy))
  return New-Object System.Drawing.Rectangle($x0, $y0, ($x1 - $x0), ($y1 - $y0))
}

function Save-Png($bmp, [string]$path) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $len = (Get-Item $path).Length
  "{0,-48} {1}x{2}  {3:N1} KB" -f $path.Substring($Root.Length + 1), $bmp.Width, $bmp.Height, ($len / 1KB)
}

# Wordmarks: trimmed, 120 px tall (sharp up to 40 px tall on 3x screens).
foreach ($pair in @(@('src\assets\logo-full.png', 'src\assets\brand\workeasy360-logo.png'), @('src\assets\logo-white.png', 'src\assets\brand\workeasy360-logo-white.png'))) {
  $src = [System.Drawing.Image]::FromFile((Join-Path $Root $pair[0]))
  try {
    $cr = Get-ContentRect $src
    $h = 120; $w = [int][Math]::Round($h * $cr.Width / $cr.Height)
    $out = New-Canvas $w $h
    try { Draw-Into $src $cr $out (New-Object System.Drawing.Rectangle(0, 0, $w, $h)) $null; Save-Png $out (Join-Path $Root $pair[1]) } finally { $out.Dispose() }
    "    content rect in source: x={0} y={1} w={2} h={3} (aspect {4:N3})" -f $cr.X, $cr.Y, $cr.Width, $cr.Height, ($cr.Width / $cr.Height)
  } finally { $src.Dispose() }
}

# The "W" mark: trimmed and centred on a square canvas.
$icon = [System.Drawing.Image]::FromFile((Join-Path $Root 'src\assets\logo-icon.png'))
try {
  $cr = Get-ContentRect $icon
  $side = [Math]::Max($cr.Width, $cr.Height)
  $square = New-Object System.Drawing.Rectangle(($cr.X - [int](($side - $cr.Width) / 2)), ($cr.Y - [int](($side - $cr.Height) / 2)), $side, $side)
  "    mark content rect: x={0} y={1} w={2} h={3}" -f $cr.X, $cr.Y, $cr.Width, $cr.Height
  # size, padding (fraction of the side on each edge), background, output
  $targets = @(
    @(128, 0.00, $null, 'src\assets\brand\workeasy360-mark.png'),
    @(32, 0.03, $null, 'public\brand\favicon-32.png'),
    @(192, 0.06, $null, 'public\brand\icon-192.png'),
    @(512, 0.06, $null, 'public\brand\icon-512.png'),
    @(180, 0.16, [System.Drawing.Color]::White, 'public\brand\apple-touch-icon.png')
  )
  foreach ($t in $targets) {
    $size = $t[0]; $pad = [int][Math]::Round($size * $t[1])
    $out = New-Canvas $size $size
    try {
      Draw-Into $icon $square $out (New-Object System.Drawing.Rectangle($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))) $t[2]
      Save-Png $out (Join-Path $Root $t[3])
    } finally { $out.Dispose() }
  }
} finally { $icon.Dispose() }

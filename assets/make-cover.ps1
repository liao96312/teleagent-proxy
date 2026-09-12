Add-Type -AssemblyName System.Drawing
$srcPath = "C:\Users\Administrator\Desktop\repo-cover.png"
$outDir = "C:\Users\Administrator\Desktop\teleagent-proxy\assets"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$src = [System.Drawing.Image]::FromFile($srcPath)
$W = [int]$src.Width
$H = [int]$src.Height
Write-Output ("source: {0}x{1}" -f $W, $H)

# 1) 裁掉底部水印
$cropH = [int]($H - 190)
Write-Output ("crop to: {0}x{1}" -f $W, $cropH)
$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $cropH)
$cropped = $src.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
Write-Output ("cropped ok: {0}x{1}" -f $cropped.Width, $cropped.Height)

# 2) 缩放到宽 1600
$nw = 1600
$nh = [int][math]::Round($cropH * $nw / $W)
$small = New-Object System.Drawing.Bitmap([int]$nw, [int]$nh)
$g = [System.Drawing.Graphics]::FromImage($small)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($cropped, 0, 0, $nw, $nh)
$g.Dispose()
Write-Output ("resized: {0}x{1}" -f $small.Width, $small.Height)

$png = Join-Path $outDir "cover.png"
$small.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("PNG saved: {0:N0} KB" -f ((Get-Item $png).Length / 1KB))

$small.Dispose(); $cropped.Dispose(); $src.Dispose()

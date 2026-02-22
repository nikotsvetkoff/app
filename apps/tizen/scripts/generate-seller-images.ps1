param(
  [string]$OutputFolder = "..\seller-assets"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Resolve-Path (Join-Path $scriptDir "..")
$targetRoot = Join-Path $scriptDir $OutputFolder

if (Test-Path $targetRoot) {
  Remove-Item -Recurse -Force $targetRoot
}

New-Item -ItemType Directory -Path $targetRoot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $targetRoot "screenshots") | Out-Null

function Get-JpegCodec {
  return [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq "image/jpeg" } |
    Select-Object -First 1
}

function Save-Jpeg {
  param(
    [Parameter(Mandatory = $true)]
    [System.Drawing.Bitmap]$Bitmap,
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [int]$Quality = 84
  )

  $codec = Get-JpegCodec
  $encoder = [System.Drawing.Imaging.Encoder]::Quality
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($encoder, [long]$Quality)
  $Bitmap.Save($Path, $codec, $params)
  $params.Dispose()
}

function New-GradientBitmap {
  param(
    [int]$Width,
    [int]$Height,
    [string]$TopHex,
    [string]$BottomHex
  )

  $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $top = [System.Drawing.ColorTranslator]::FromHtml($TopHex)
  $bottom = [System.Drawing.ColorTranslator]::FromHtml($BottomHex)

  $rect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $top, $bottom, 90)
  $g.FillRectangle($brush, $rect)

  $brush.Dispose()
  $g.Dispose()
  return $bmp
}

function Draw-OverlayChrome {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [string]$Title,
    [string]$SubTitle
  )

  $g = [System.Drawing.Graphics]::FromImage($Bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $panelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180, 17, 29, 42))
  $accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 173, 67))
  $mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 223, 232, 240))

  $titleFont = New-Object System.Drawing.Font("Segoe UI", 54, [System.Drawing.FontStyle]::Bold)
  $subFont = New-Object System.Drawing.Font("Segoe UI", 28, [System.Drawing.FontStyle]::Regular)

  $g.FillRectangle($panelBrush, 80, 80, $Bitmap.Width - 160, 220)
  $g.FillRectangle($accentBrush, 80, 80, 14, 220)
  $g.DrawString($Title, $titleFont, $accentBrush, 120, 110)
  $g.DrawString($SubTitle, $subFont, $mutedBrush, 124, 192)

  $railBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(170, 8, 16, 25))
  $g.FillRectangle($railBrush, 80, 350, 540, 620)

  for ($i = 0; $i -lt 9; $i++) {
    $isSelected = $i -eq 2
    $bg = if ($isSelected) { [System.Drawing.Color]::FromArgb(220, 47, 77, 99) } else { [System.Drawing.Color]::FromArgb(190, 35, 52, 68) }
    $itemBrush = New-Object System.Drawing.SolidBrush($bg)
    $y = 380 + ($i * 62)
    $g.FillRectangle($itemBrush, 106, $y, 486, 50)

    $textBrush = if ($isSelected) {
      New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 213, 106))
    } else {
      New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(245, 236, 242, 248))
    }

    $font = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Regular)
    $g.DrawString(("Channel {0}" -f ($i + 1)), $font, $textBrush, 128, $y + 12)

    $font.Dispose()
    $textBrush.Dispose()
    $itemBrush.Dispose()
  }

  $playerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(210, 6, 10, 16))
  $playerRectX = 660
  $playerRectY = 350
  $playerRectW = $Bitmap.Width - 740
  $playerRectH = 620
  $g.FillRectangle($playerBrush, $playerRectX, $playerRectY, $playerRectW, $playerRectH)

  $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(245, 255, 173, 67))
  $g.FillRectangle($lineBrush, $playerRectX + 42, $playerRectY + $playerRectH - 74, $playerRectW - 84, 8)

  $smallFont = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold)
  $g.DrawString("Now: Live News Update", $smallFont, $mutedBrush, $playerRectX + 36, $playerRectY + $playerRectH - 138)

  $smallFont.Dispose()
  $playerBrush.Dispose()
  $lineBrush.Dispose()
  $railBrush.Dispose()
  $panelBrush.Dispose()
  $accentBrush.Dispose()
  $mutedBrush.Dispose()
  $titleFont.Dispose()
  $subFont.Dispose()
  $g.Dispose()
}

function New-TransparentLogo1920 {
  $bmp = New-Object System.Drawing.Bitmap(1920, 1080, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 173, 67))
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 247, 250, 252))

  $titleFont = New-Object System.Drawing.Font("Segoe UI", 138, [System.Drawing.FontStyle]::Bold)
  $subFont = New-Object System.Drawing.Font("Segoe UI", 58, [System.Drawing.FontStyle]::Regular)

  $g.DrawString("IPTV", $titleFont, $accent, 582, 350)
  $g.DrawString("SMART TV MVP", $subFont, $white, 616, 540)

  $accent.Dispose()
  $white.Dispose()
  $titleFont.Dispose()
  $subFont.Dispose()
  $g.Dispose()
  return $bmp
}

function New-Icon512x423 {
  $bmp = New-Object System.Drawing.Bitmap(512, 423, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $bgRect = New-Object System.Drawing.Rectangle(0, 0, 512, 423)
  $top = [System.Drawing.ColorTranslator]::FromHtml("#24374A")
  $bottom = [System.Drawing.ColorTranslator]::FromHtml("#0E1824")
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($bgRect, $top, $bottom, 90)
  $g.FillRectangle($bgBrush, $bgRect)

  $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 173, 67))
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 246, 250, 255))

  $titleFont = New-Object System.Drawing.Font("Segoe UI", 90, [System.Drawing.FontStyle]::Bold)
  $subFont = New-Object System.Drawing.Font("Segoe UI", 28, [System.Drawing.FontStyle]::Regular)

  $g.DrawString("TV", $titleFont, $accent, 134, 112)
  $g.DrawString("IPTV", $subFont, $white, 182, 244)

  $bgBrush.Dispose()
  $accent.Dispose()
  $white.Dispose()
  $titleFont.Dispose()
  $subFont.Dispose()
  $g.Dispose()
  return $bmp
}

# 1) 1920x1080 background image
$bg = New-GradientBitmap -Width 1920 -Height 1080 -TopHex "#1E3447" -BottomHex "#0A131C"
Draw-OverlayChrome -Bitmap $bg -Title "IPTV Smart TV" -SubTitle "Background image for Seller Office"
Save-Jpeg -Bitmap $bg -Path (Join-Path $targetRoot "app-image-1920x1080-background.jpg") -Quality 80
$bg.Dispose()

# 2) 1920x1080 transparent logo
$logo = New-TransparentLogo1920
$logo.Save((Join-Path $targetRoot "app-image-1920x1080-logo.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$logo.Dispose()

# 3) 512x423 app icon
$icon = New-Icon512x423
$icon.Save((Join-Path $targetRoot "app-icon-512x423.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$icon.Dispose()

# 4) 4 screenshots
$screenshotTitles = @(
  @("Home & Channels", "Channel list and playback surface"),
  @("Search & Focus", "Remote-first navigation flow"),
  @("Now / Next Overlay", "Program metadata and progress"),
  @("Favorites", "Persistent local favorites on TV")
)

for ($i = 0; $i -lt $screenshotTitles.Count; $i++) {
  $bmp = New-GradientBitmap -Width 1920 -Height 1080 -TopHex "#203748" -BottomHex "#0B121A"
  Draw-OverlayChrome -Bitmap $bmp -Title $screenshotTitles[$i][0] -SubTitle $screenshotTitles[$i][1]
  $path = Join-Path $targetRoot ("screenshots\screenshot-{0}.jpg" -f ($i + 1))
  Save-Jpeg -Bitmap $bmp -Path $path -Quality 82
  $bmp.Dispose()
}

Write-Host "Generated Seller Office image set at: $targetRoot"
Get-ChildItem -Recurse $targetRoot | Where-Object { -not $_.PSIsContainer } | Select-Object Name, Length | Format-Table -AutoSize

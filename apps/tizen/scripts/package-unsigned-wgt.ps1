param(
  [string]$OutputName = "iptv-tizen-unsigned.wgt"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Resolve-Path (Join-Path $scriptDir "..")
$repoDir = Resolve-Path (Join-Path $appDir "..\..")

Push-Location $repoDir
try {
  corepack pnpm -r --filter @iptv/tizen... build
  if ($LASTEXITCODE -ne 0) {
    throw "Tizen build failed."
  }

  $distDir = Join-Path $appDir "dist"
  if (-not (Test-Path $distDir)) {
    throw "Missing dist directory. Build output not found."
  }

  $stageDir = Join-Path $appDir ".wgt-staging"
  if (Test-Path $stageDir) {
    Remove-Item $stageDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $stageDir | Out-Null

  Copy-Item (Join-Path $distDir "*") $stageDir -Recurse -Force
  Copy-Item (Join-Path $appDir "config.xml") $stageDir -Force

  $iconPath = Join-Path $appDir "icon.png"
  if (Test-Path $iconPath) {
    Copy-Item $iconPath $stageDir -Force
  }

  $artifactsDir = Join-Path $appDir "artifacts"
  New-Item -ItemType Directory -Path $artifactsDir -Force | Out-Null

  $outputBase = [System.IO.Path]::GetFileNameWithoutExtension($OutputName)
  $zipPath = Join-Path $artifactsDir ("$outputBase.zip")
  $wgtPath = Join-Path $artifactsDir $OutputName

  if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
  }

  if (Test-Path $wgtPath) {
    Remove-Item $wgtPath -Force
  }

  Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
  Rename-Item -Path $zipPath -NewName $OutputName

  Write-Host "Unsigned package created: $wgtPath"
  Write-Host "IMPORTANT: Unsigned .wgt cannot be installed on retail TVs."
}
finally {
  Pop-Location
}
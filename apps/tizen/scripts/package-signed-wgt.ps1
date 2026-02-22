param(
  [string]$ProfileName = "IptvProfile"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Resolve-Path (Join-Path $scriptDir "..")
$repoDir = Resolve-Path (Join-Path $appDir "..\..")

$tizenCommand = Get-Command tizen -ErrorAction SilentlyContinue
$tizenCli = $null
if ($tizenCommand) {
  $tizenCli = $tizenCommand.Source
}
if (-not $tizenCli) {
  $fallbackCli = "C:\tizen-studio\tools\ide\bin\tizen.bat"
  if (Test-Path $fallbackCli) {
    $tizenCli = $fallbackCli
  } else {
    throw "Tizen CLI not found. Install Tizen Studio CLI and add it to PATH first."
  }
}

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

  & $tizenCli package -t wgt -s $ProfileName -o "$artifactsDir" -- "$stageDir"
  if ($LASTEXITCODE -ne 0) {
    throw "tizen package command failed. Verify certificate profile and Tizen CLI setup."
  }

  $latest = Get-ChildItem $artifactsDir -Filter *.wgt | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) {
    throw "No signed .wgt found in artifacts folder."
  }

  Write-Host "Signed package created: $($latest.FullName)"
}
finally {
  Pop-Location
}

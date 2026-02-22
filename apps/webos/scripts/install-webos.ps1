param(
  [string]$Device,
  [switch]$PackageOnly,
  [switch]$SkipBuild,
  [switch]$SkipLaunch,
  [switch]$NoCleanup
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-CliCommand {
  param(
    [Parameter(Mandatory = $true)][string]$CommandName
  )

  cmd /c "where $CommandName >nul 2>nul"
  return $LASTEXITCODE -eq 0
}

function Get-NodeMajorVersion {
  try {
    $versionText = (& node -v).Trim()
    if ($versionText -match "^v(\d+)") {
      return [int]$Matches[1]
    }
  }
  catch {
    return 0
  }

  return 0
}

function Resolve-CliFlavor {
  if (Test-CliCommand -CommandName "ares-package") {
    return "legacy"
  }

  if (Test-CliCommand -CommandName "ares") {
    return "modern"
  }

  return $null
}

$cliFlavor = Resolve-CliFlavor
if (-not $cliFlavor) {
  throw "webOS CLI not found. Install @webos-tools/cli globally (npm i -g @webos-tools/cli)."
}

$nodeMajorVersion = Get-NodeMajorVersion
$aresBinDir = Join-Path $env:APPDATA "npm\node_modules\@webos-tools\cli\bin"
$useNode20LegacyAres = (
  $cliFlavor -eq "legacy" -and
  $nodeMajorVersion -gt 20 -and
  (Test-CliCommand -CommandName "npx")
)

function Invoke-LegacyAresCommand {
  param(
    [Parameter(Mandatory = $true)][string]$CommandName,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  if ($useNode20LegacyAres) {
    $legacyScriptPath = Join-Path $aresBinDir ("$CommandName.js")
    if (Test-Path $legacyScriptPath) {
      & cmd /c npx -y node@20 $legacyScriptPath @Arguments
      return
    }
  }

  & cmd /c $CommandName @Arguments
}

function Invoke-AresPackage {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$OutDir
  )

  if ($cliFlavor -eq "legacy") {
    Invoke-LegacyAresCommand -CommandName "ares-package" -Arguments @("--outdir", $OutDir, $SourceDir)
  } else {
    & cmd /c ares package --outdir $OutDir $SourceDir
  }

  if ($LASTEXITCODE -ne 0) {
    throw "webOS package command failed."
  }
}

function Invoke-AresInstall {
  param(
    [Parameter(Mandatory = $true)][string]$DeviceName,
    [Parameter(Mandatory = $true)][string]$IpkPath
  )

  if ($cliFlavor -eq "legacy") {
    Invoke-LegacyAresCommand -CommandName "ares-install" -Arguments @("--device", $DeviceName, $IpkPath)
  } else {
    & cmd /c ares install --device $DeviceName $IpkPath
  }

  if ($LASTEXITCODE -ne 0) {
    throw "webOS install command failed for device '$DeviceName'."
  }
}

function Invoke-AresLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$DeviceName,
    [Parameter(Mandatory = $true)][string]$AppId
  )

  if ($cliFlavor -eq "legacy") {
    Invoke-LegacyAresCommand -CommandName "ares-launch" -Arguments @("--device", $DeviceName, $AppId)
  } else {
    & cmd /c ares launch --device $DeviceName $AppId
  }

  if ($LASTEXITCODE -ne 0) {
    throw "webOS launch command failed for app '$AppId' on device '$DeviceName'."
  }
}

if (-not $PackageOnly -and [string]::IsNullOrWhiteSpace($Device)) {
  throw "Missing device alias. Use -Device <alias> or run with -PackageOnly."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Resolve-Path (Join-Path $scriptDir "..")
$repoDir = Resolve-Path (Join-Path $appDir "..\..")

$appInfoPath = Join-Path $appDir "public\appinfo.json"
if (-not (Test-Path $appInfoPath)) {
  throw "Missing app metadata file: $appInfoPath"
}

$appInfo = Get-Content $appInfoPath -Raw | ConvertFrom-Json
$appId = $appInfo.id
if ([string]::IsNullOrWhiteSpace($appId)) {
  throw "App id missing in appinfo.json."
}

Push-Location $repoDir
try {
  if (-not $SkipBuild) {
    corepack pnpm -r --filter @iptv/webos... build
    if ($LASTEXITCODE -ne 0) {
      throw "Build failed for @iptv/webos."
    }
  }

  $distDir = Join-Path $appDir "dist"
  if (-not (Test-Path $distDir)) {
    throw "Missing dist directory. Build output not found: $distDir"
  }

  $publicDir = Join-Path $appDir "public"
  $stageDir = Join-Path $appDir ".ipk-staging"
  if (Test-Path $stageDir) {
    Remove-Item $stageDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $stageDir | Out-Null

  $artifactsDir = Join-Path $appDir "artifacts"
  New-Item -ItemType Directory -Path $artifactsDir -Force | Out-Null

  try {
    Copy-Item (Join-Path $distDir "*") $stageDir -Recurse -Force
    if (Test-Path $publicDir) {
      Copy-Item (Join-Path $publicDir "*") $stageDir -Recurse -Force
    }

    foreach ($requiredKey in @("main", "icon", "largeIcon")) {
      if ($null -eq $appInfo.$requiredKey) {
        continue
      }

      $value = [string]$appInfo.$requiredKey
      if ([string]::IsNullOrWhiteSpace($value)) {
        continue
      }

      $assetPath = Join-Path $stageDir $value
      if (-not (Test-Path $assetPath)) {
        throw "Missing required asset '$value' referenced by '$requiredKey' in appinfo.json."
      }
    }

    $existingIpkPaths = @(
      Get-ChildItem $artifactsDir -Filter *.ipk -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName }
    )

    Invoke-AresPackage -SourceDir $stageDir -OutDir $artifactsDir

    $allIpks = @(
      Get-ChildItem $artifactsDir -Filter *.ipk -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    )

    if ($allIpks.Length -eq 0) {
      throw "Packaging completed but no .ipk artifact was found in: $artifactsDir"
    }

    $newIpks = @(
      $allIpks |
      Where-Object { $existingIpkPaths -notcontains $_.FullName } |
      Sort-Object LastWriteTime -Descending
    )

    $ipkFile = if ($newIpks.Length -gt 0) { $newIpks[0] } else { $allIpks[0] }
    Write-Host "IPK artifact: $($ipkFile.FullName)"

    if ($PackageOnly) {
      return
    }

    Invoke-AresInstall -DeviceName $Device -IpkPath $ipkFile.FullName
    Write-Host "Installed app '$appId' on device '$Device'."

    if (-not $SkipLaunch) {
      Invoke-AresLaunch -DeviceName $Device -AppId $appId
      Write-Host "Launched app '$appId' on device '$Device'."
    }
  }
  finally {
    if (-not $NoCleanup -and (Test-Path $stageDir)) {
      Remove-Item $stageDir -Recurse -Force
    }
  }
}
finally {
  Pop-Location
}

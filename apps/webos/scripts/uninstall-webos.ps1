param(
  [Parameter(Mandatory = $true)][string]$Device,
  [string]$AppId
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
  if (Test-CliCommand -CommandName "ares-install") {
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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Resolve-Path (Join-Path $scriptDir "..")

if ([string]::IsNullOrWhiteSpace($AppId)) {
  $appInfoPath = Join-Path $appDir "public\appinfo.json"
  if (-not (Test-Path $appInfoPath)) {
    throw "Missing app metadata file: $appInfoPath"
  }

  $appInfo = Get-Content $appInfoPath -Raw | ConvertFrom-Json
  $AppId = $appInfo.id
}

if ([string]::IsNullOrWhiteSpace($AppId)) {
  throw "App id is required. Pass -AppId or set id in appinfo.json."
}

if ($cliFlavor -eq "legacy") {
  Invoke-LegacyAresCommand -CommandName "ares-install" -Arguments @("--device", $Device, "--remove", $AppId)
} else {
  & cmd /c ares install --device $Device --remove $AppId
}

if ($LASTEXITCODE -ne 0) {
  throw "Failed to uninstall app '$AppId' from device '$Device'."
}

Write-Host "Uninstalled app '$AppId' from device '$Device'."

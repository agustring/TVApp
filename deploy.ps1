# Created by Agustin Copita in 2026 for the exclusive use of Agustin Copita.
# © 2026 Agustin Copita. All rights reserved.
#
# Build, package and deploy TVApp (full name: TuViejapp) to a Samsung Smart TV.
#
# Why not just "tz install"? On a retail TV the set reports
# secure_protocol:enabled, so arbitrary "sdb shell" commands are refused with
# "closed". tz install runs "sdb shell 0 vd_appuninstall" before installing and
# therefore fails as soon as the app is already on the TV. Pushing the .wgt and
# calling vd_appinstall directly upgrades in place and skips the uninstall.
#
# Usage:
#   .\deploy.ps1 -TvIp 192.168.1.50      # build + install + launch
#   .\deploy.ps1 -NoBuild                # reinstall the existing package
#   .\deploy.ps1 -TizenTools "C:\tizen-studio\tools"

param(
    [string]$TvIp,
    [string]$TizenTools,
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

# The project is wherever this script lives, so the repo can be cloned anywhere.
$Project = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$Wgt     = Join-Path $Project "Debug\TVApp.wgt"
$AppId   = "TuVieja001.TuViejapp"
$Remote  = "/home/owner/share/tmp/sdk_tools/tmp/TVApp.wgt"

# --- locate the Tizen tools -------------------------------------------------
# Both the VS Code Tizen extension and a full Tizen Studio install are supported.
if (-not $TizenTools) {
    $candidates = @(
        (Join-Path $env:USERPROFILE ".tizen-extension-platform\server\sdktools\data\tools"),
        (Join-Path $env:USERPROFILE "tizen-studio\tools"),
        "C:\tizen-studio\tools"
    )
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c "sdb.exe")) { $TizenTools = $c; break }
    }
}
if (-not $TizenTools -or -not (Test-Path (Join-Path $TizenTools "sdb.exe"))) {
    Write-Host "Could not find the Tizen tools. Pass -TizenTools <path to tizen-studio\tools>." -ForegroundColor Red
    exit 1
}

$Sdb = Join-Path $TizenTools "sdb.exe"
$Tz  = Join-Path $TizenTools "tizen-core\tz.exe"

# --- TV address -------------------------------------------------------------
# Remembered in TVAPP_TV_IP so it only has to be typed once per machine. The old
# TUVIEJAPP_TV_IP name still works, so machines set up before the rename do not
# have to be touched.
if (-not $TvIp) { $TvIp = $env:TVAPP_TV_IP }
if (-not $TvIp) { $TvIp = $env:TUVIEJAPP_TV_IP }
if (-not $TvIp) {
    Write-Host "No TV address. Pass -TvIp <ip> or set TVAPP_TV_IP." -ForegroundColor Red
    exit 1
}
$Target = "${TvIp}:26101"

# --- build ------------------------------------------------------------------
if (-not $NoBuild) {
    if (-not (Test-Path $Tz)) {
        Write-Host "tz.exe not found at $Tz - use -NoBuild, or build in Tizen Studio." -ForegroundColor Red
        exit 1
    }
    Write-Host "==> Building" -ForegroundColor Cyan
    & $Tz build -w $Project | Select-Object -Last 3
    Write-Host "==> Packaging" -ForegroundColor Cyan
    & $Tz pack -w $Project -t wgt | Select-Object -Last 2
}

if (-not (Test-Path $Wgt)) {
    Write-Host "No package at $Wgt. Run without -NoBuild first." -ForegroundColor Red
    exit 1
}

# --- connect ----------------------------------------------------------------
# The sdb link goes stale often, and a stale link reports "already connected"
# while every command still fails. Restarting the server first is reliable.
Write-Host "==> Connecting to $Target" -ForegroundColor Cyan
& $Sdb kill-server  2>&1 | Out-Null
& $Sdb start-server 2>&1 | Out-Null
& $Sdb connect $TvIp

# Join to a single string: -notmatch against an array returns the non-matching
# ELEMENTS (e.g. the "List of devices attached" header), which is always truthy.
$Attached = (& $Sdb devices) -join "`n"
if ($Attached -notmatch [regex]::Escape($TvIp)) {
    Write-Host "TV not reachable. Check that it is powered on, on the same" -ForegroundColor Red
    Write-Host "network, and that Developer Mode is still enabled." -ForegroundColor Red
    exit 1
}

# --- install + launch -------------------------------------------------------
Write-Host "==> Pushing package" -ForegroundColor Cyan
& $Sdb -s $Target push $Wgt $Remote | Select-Object -Last 1

Write-Host "==> Installing" -ForegroundColor Cyan
& $Sdb -s $Target shell 0 vd_appinstall $AppId $Remote | Select-Object -Last 3

# Reinstalling restarts the app process, which is the only way to force a fresh
# load: "was_kill" is rejected on retail firmware, and was_execute on a running
# app merely resumes it without re-running window.onload.
Write-Host "==> Launching" -ForegroundColor Cyan
& $Sdb -s $Target shell 0 was_execute $AppId | Select-Object -Last 3

Write-Host "Done." -ForegroundColor Green

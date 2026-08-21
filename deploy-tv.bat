@echo off
setlocal

rem Double-click launcher for building and deploying TVApp.
rem Edit deploy-tv.config before the first run.
set "CONFIG=%~dp0deploy-tv.config"
set "TV_IP="
set "TIZEN_TOOLS="
set "NO_BUILD=false"

if exist "%CONFIG%" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%CONFIG%") do (
        if /I "%%A"=="tv_ip" set "TV_IP=%%B"
        if /I "%%A"=="tizen_tools" set "TIZEN_TOOLS=%%B"
        if /I "%%A"=="no_build" set "NO_BUILD=%%B"
    )
)

if not defined TV_IP (
    echo Missing tv_ip in deploy-tv.config.
    echo Enter the TV IP shown in Developer Mode, then run this file again.
    pause
    exit /b 1
)

set "NO_BUILD_ARG="
if /I "%NO_BUILD%"=="true" set "NO_BUILD_ARG=-NoBuild"
if defined TIZEN_TOOLS (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -TvIp "%TV_IP%" -TizenTools "%TIZEN_TOOLS%" %NO_BUILD_ARG%
) else (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -TvIp "%TV_IP%" %NO_BUILD_ARG%
)
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo TVApp deployment completed.
) else (
    echo TVApp deployment failed with exit code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%

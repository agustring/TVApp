@echo off
setlocal

rem TVApp zero-install video server.
rem Edit video-server.config before starting, or pass a folder and port here.
rem Usage: video-server.bat "D:\Movies" 8001
set "TVAPP_CONFIG=%~dp0video-server.config"
rem Passed to the server below so it can relaunch this file elevated.
set "TVAPP_SELF=%~f0"
set "TVAPP_ROOT="
set "TVAPP_PORT="
if exist "%TVAPP_CONFIG%" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%TVAPP_CONFIG%") do (
        if /I "%%A"=="root" set "TVAPP_ROOT=%%B"
        if /I "%%A"=="port" set "TVAPP_PORT=%%B"
    )
)
if not "%~1"=="" set "TVAPP_ROOT=%~1"
if not "%~2"=="" set "TVAPP_PORT=%~2"
if not defined TVAPP_ROOT set "TVAPP_ROOT=%~dp0"
if not defined TVAPP_PORT set "TVAPP_PORT=8001"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$lines = Get-Content -LiteralPath '%~f0'; $marker = [Array]::IndexOf($lines, '# --- POWERSHELL SERVER ---'); if ($marker -lt 0) { exit 2 }; & ([scriptblock]::Create(($lines[($marker + 1)..($lines.Count - 1)] -join [Environment]::NewLine)))"
set "EXIT_CODE=%ERRORLEVEL%"
rem Keep the window up on failure, otherwise a double-click just flashes.
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%

# --- POWERSHELL SERVER ---
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($env:TVAPP_ROOT)
$port = [int]$env:TVAPP_PORT
$minMediaBytes = 20MB
$maxDepth = 8
$mediaExtensions = @('.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.ts')
$mime = @{
    '.mp4' = 'video/mp4'; '.m4v' = 'video/mp4'; '.webm' = 'video/webm'
    '.mkv' = 'video/x-matroska'; '.avi' = 'video/x-msvideo'; '.mov' = 'video/quicktime'
    '.ts' = 'video/mp2t'
}

if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    Write-Host "Folder not found: $root" -ForegroundColor Red
    exit 1
}

# Without administrator rights HttpListener can only bind loopback, and a
# loopback-only server is invisible to the TV, so relaunch this file elevated.
# The folder and port go along, so command line arguments survive the prompt.
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    try {
        # Elevating cmd.exe, not the .bat: ShellExecute silently declines the
        # runas verb on a batch file. "call" keeps cmd from mangling the quotes.
        Start-Process -FilePath $env:ComSpec -Verb RunAs `
            -ArgumentList '/c', "call `"$env:TVAPP_SELF`" `"$root`" $port"
    } catch {
        Write-Host 'Administrator rights are needed to serve the TV. Start again and accept the prompt.' -ForegroundColor Red
        exit 1
    }
    exit 0
}

function Test-Hidden([string]$name) {
    return $name.StartsWith('.')
}

function Test-Media([string]$name) {
    return $mediaExtensions -contains ([IO.Path]::GetExtension($name).ToLowerInvariant())
}

function Test-HasVideo([string]$directory, [int]$depth = 0) {
    try { $entries = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) } catch { return $false }

    foreach ($entry in $entries) {
        if (-not $entry.PSIsContainer -and -not (Test-Hidden $entry.Name) -and
            (Test-Media $entry.Name) -and $entry.Length -ge $minMediaBytes) { return $true }
    }
    if ($depth -ge $maxDepth) { return $false }

    foreach ($entry in $entries) {
        if ($entry.PSIsContainer -and -not (Test-Hidden $entry.Name) -and
            (Test-HasVideo $entry.FullName ($depth + 1))) { return $true }
    }
    return $false
}

function Convert-ToHtml([string]$value) {
    return [Net.WebUtility]::HtmlEncode($value)
}

function Send-Bytes($context, [byte[]]$bytes, [int]$status, [string]$contentType) {
    $context.Response.StatusCode = $status
    $context.Response.ContentType = $contentType
    $context.Response.ContentLength64 = $bytes.Length
    $context.Response.Headers['Access-Control-Allow-Origin'] = '*'
    if ($context.Request.HttpMethod -ne 'HEAD') { $context.Response.OutputStream.Write($bytes, 0, $bytes.Length) }
    $context.Response.Close()
}

function Send-Listing($context, [string]$directory, [string]$relative) {
    $entries = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction SilentlyContinue)
    $directories = @($entries | Where-Object {
        $_.PSIsContainer -and -not (Test-Hidden $_.Name) -and (Test-HasVideo $_.FullName)
    } | Sort-Object Name)
    $files = @($entries | Where-Object {
        -not $_.PSIsContainer -and -not (Test-Hidden $_.Name) -and (Test-Media $_.Name)
    } | Sort-Object Name)

    $links = @()
    foreach ($entry in $directories) {
        $href = [Uri]::EscapeDataString($entry.Name) + '/'
        $links += '<li><a href="' + $href + '">' + (Convert-ToHtml $entry.Name) + '/</a></li>'
    }
    foreach ($entry in $files) {
        $href = [Uri]::EscapeDataString($entry.Name)
        $links += '<li><a href="' + $href + '">' + (Convert-ToHtml $entry.Name) + '</a></li>'
    }

    $title = Convert-ToHtml ('Directory listing for /' + $relative)
    $body = '<!DOCTYPE HTML><html><head><meta charset="utf-8"><title>' + $title +
        '</title></head><body><h1>' + $title + '</h1><hr><ul>' +
        ($links -join "`n") + '</ul><hr></body></html>'
    Send-Bytes $context ([Text.Encoding]::UTF8.GetBytes($body)) 200 'text/html; charset=utf-8'
}

function Send-File($context, [IO.FileInfo]$file) {
    $response = $context.Response
    $response.Headers['Access-Control-Allow-Origin'] = '*'
    $response.Headers['Accept-Ranges'] = 'bytes'
    $response.ContentType = if ($mime.ContainsKey($file.Extension.ToLowerInvariant())) {
        $mime[$file.Extension.ToLowerInvariant()]
    } else { 'application/octet-stream' }

    $start = 0L
    $end = $file.Length - 1
    $range = $context.Request.Headers['Range']
    if ($range -and $range -match '^bytes=(\d*)-(\d*)$') {
        if ($Matches[1]) { $start = [int64]$Matches[1] }
        if ($Matches[2]) { $end = [int64]$Matches[2] }
        if (-not $Matches[1] -and $Matches[2]) {
            $length = [int64]$Matches[2]
            $start = [Math]::Max(0, $file.Length - $length)
            $end = $file.Length - 1
        }
        if ($start -ge $file.Length -or $start -gt $end) {
            $response.StatusCode = 416
            $response.Headers['Content-Range'] = "bytes */$($file.Length)"
            $response.Close()
            return
        }
        $end = [Math]::Min($end, $file.Length - 1)
        $response.StatusCode = 206
        $response.Headers['Content-Range'] = "bytes $start-$end/$($file.Length)"
    } else { $response.StatusCode = 200 }

    $count = $end - $start + 1
    $response.ContentLength64 = $count
    if ($context.Request.HttpMethod -eq 'HEAD') { $response.Close(); return }

    $stream = New-Object IO.FileStream($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $stream.Seek($start, [IO.SeekOrigin]::Begin) | Out-Null
        $buffer = New-Object byte[] 65536
        while ($count -gt 0) {
            $read = $stream.Read($buffer, 0, [Math]::Min($buffer.Length, $count))
            if ($read -le 0) { break }
            $response.OutputStream.Write($buffer, 0, $read)
            $count -= $read
        }
    } finally { $stream.Dispose(); $response.Close() }
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://+:$port/")
try {
    $listener.Start()
} catch {
    Write-Host "Could not listen on port $port. Another program may already hold it, or Windows Firewall may be blocking it." -ForegroundColor Red
    exit 1
}
Write-Host "Serving $root on http://0.0.0.0:$port/" -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop.'

while ($listener.IsListening) {
    try { $context = $listener.GetContext() } catch { break }
    try {
        if ($context.Request.HttpMethod -notin @('GET', 'HEAD')) {
            $context.Response.StatusCode = 405
            $context.Response.Headers['Allow'] = 'GET, HEAD'
            $context.Response.Close()
            continue
        }
        $rawPath = $context.Request.Url.AbsolutePath
        $relative = [Uri]::UnescapeDataString($rawPath).TrimStart('/')
        $candidate = [IO.Path]::GetFullPath((Join-Path $root $relative))
        $rootWithSlash = $root.TrimEnd('\') + '\'
        if ($candidate -ne $root -and -not $candidate.StartsWith($rootWithSlash, [StringComparison]::OrdinalIgnoreCase)) {
            Send-Bytes $context ([Text.Encoding]::UTF8.GetBytes('403 Forbidden')) 403 'text/plain'
            continue
        }
        if (-not (Test-Path -LiteralPath $candidate)) {
            Send-Bytes $context ([Text.Encoding]::UTF8.GetBytes('404 Not Found')) 404 'text/plain'
            continue
        }
        $item = Get-Item -LiteralPath $candidate
        if ($item.PSIsContainer) {
            if (-not $rawPath.EndsWith('/')) {
                $context.Response.StatusCode = 301
                $context.Response.RedirectLocation = $rawPath + '/'
                $context.Response.Close()
            } else {
                $relativeForTitle = $relative.TrimEnd('/')
                Send-Listing $context $candidate $relativeForTitle
            }
        } else { Send-File $context $item }
    } catch {
        try { $context.Response.StatusCode = 500; $context.Response.Close() } catch { }
        Write-Host $_.Exception.Message -ForegroundColor Yellow
    }
}
$listener.Stop()

[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolDir = Join-Path $projectRoot "tools"
$cloudflaredPath = Join-Path $toolDir "cloudflared.exe"
$configDir = Join-Path $projectRoot "config"
$credentialPath = Join-Path $configDir "share-access.dpapi"
$tempDir = Join-Path $projectRoot "tmp"
$serverPidPath = Join-Path $tempDir "temporary-share-server.pid"
$tunnelPidPath = Join-Path $tempDir "temporary-share-tunnel.pid"
$serverOutPath = Join-Path $tempDir "temporary-share-server.out.log"
$serverErrorPath = Join-Path $tempDir "temporary-share-server.error.log"
$tunnelOutPath = Join-Path $tempDir "temporary-share-tunnel.out.log"
$tunnelErrorPath = Join-Path $tempDir "temporary-share-tunnel.error.log"
$sharePort = 8766

New-Item -ItemType Directory -Force -Path $toolDir, $configDir, $tempDir | Out-Null

function Stop-ProcessSafely {
    param([AllowNull()][System.Diagnostics.Process]$Process)
    if ($null -ne $Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $Process.Id -Timeout 5 -ErrorAction SilentlyContinue
    }
}

function Get-PythonPath {
    $candidates = @(
        (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe")
    )
    foreach ($commandName in @("python.exe", "python")) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($command) { $candidates += $command.Source }
    }
    return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Get-ShareCredential {
    if (-not (Test-Path -LiteralPath $credentialPath)) {
        $bytes = New-Object byte[] 18
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
        $password = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "A").Replace("/", "B")
        $json = [ordered]@{ username = "preview"; password = $password } | ConvertTo-Json -Compress
        $encrypted = ConvertFrom-SecureString (ConvertTo-SecureString $json -AsPlainText -Force)
        Set-Content -LiteralPath $credentialPath -Value $encrypted -Encoding UTF8
    }

    $encrypted = (Get-Content -LiteralPath $credentialPath -Raw -Encoding UTF8).Trim()
    $secure = ConvertTo-SecureString -String $encrypted
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $json = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        return $json | ConvertFrom-Json
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

if (-not (Test-Path -LiteralPath $cloudflaredPath)) {
    Write-Host "首次使用：正在下载 Cloudflare 官方临时分享工具……" -ForegroundColor Cyan
    $downloadPath = Join-Path $toolDir "cloudflared.download.exe"
    $previousProgressPreference = $ProgressPreference
    try {
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $downloadPath -TimeoutSec 180
        & $downloadPath --version | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "下载的 cloudflared 无法运行。" }
        Move-Item -LiteralPath $downloadPath -Destination $cloudflaredPath -Force
    }
    finally {
        $ProgressPreference = $previousProgressPreference
        if (Test-Path -LiteralPath $downloadPath) { Remove-Item -LiteralPath $downloadPath -Force }
    }
}

$existingListener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $sharePort -State Listen -ErrorAction SilentlyContinue
if ($existingListener) {
    throw ('临时分享端口 {0} 已被占用。请先双击“停止临时分享.cmd”，然后重试。' -f $sharePort)
}

$pythonPath = Get-PythonPath
if (-not $pythonPath) { throw "未找到 Python，无法启动临时分享。" }

$credential = Get-ShareCredential
$serverProcess = $null
$tunnelProcess = $null
$environmentNames = @("HOST", "PORT", "DASHBOARD_USERNAME", "DASHBOARD_PASSWORD", "ENABLE_SERVER_SYNC")
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
    Remove-Item -LiteralPath $serverOutPath, $serverErrorPath, $tunnelOutPath, $tunnelErrorPath -Force -ErrorAction SilentlyContinue
    $env:HOST = "127.0.0.1"
    $env:PORT = [string]$sharePort
    $env:DASHBOARD_USERNAME = [string]$credential.username
    $env:DASHBOARD_PASSWORD = [string]$credential.password
    $env:ENABLE_SERVER_SYNC = ""

    $serverScript = Join-Path $PSScriptRoot "serve_dashboard.py"
    $serverProcess = Start-Process -FilePath $pythonPath -ArgumentList ('"{0}"' -f $serverScript) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $serverOutPath -RedirectStandardError $serverErrorPath -PassThru
    Set-Content -LiteralPath $serverPidPath -Value $serverProcess.Id -Encoding ASCII

    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $sharePort -State Listen -ErrorAction SilentlyContinue
        if ($serverProcess.HasExited) {
            $serverError = Get-Content -LiteralPath $serverErrorPath -Raw -ErrorAction SilentlyContinue
            throw "看板服务启动失败：$serverError"
        }
    } until ($listener -or (Get-Date) -ge $deadline)
    if (-not $listener) { throw "看板服务未能在 15 秒内启动。" }

    $tunnelProcess = Start-Process -FilePath $cloudflaredPath -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$sharePort", "--no-autoupdate") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $tunnelOutPath -RedirectStandardError $tunnelErrorPath -PassThru
    Set-Content -LiteralPath $tunnelPidPath -Value $tunnelProcess.Id -Encoding ASCII

    Write-Host "正在生成临时访问地址……" -ForegroundColor Cyan
    $deadline = (Get-Date).AddSeconds(45)
    $shareUrl = $null
    do {
        Start-Sleep -Milliseconds 500
        $tunnelText = @(
            (Get-Content -LiteralPath $tunnelOutPath -Raw -ErrorAction SilentlyContinue),
            (Get-Content -LiteralPath $tunnelErrorPath -Raw -ErrorAction SilentlyContinue)
        ) -join "`n"
        $match = [regex]::Match($tunnelText, 'https://[a-z0-9-]+\.trycloudflare\.(?:com|app)')
        if ($match.Success) { $shareUrl = $match.Value }
        if ($tunnelProcess.HasExited -and -not $shareUrl) {
            throw "Cloudflare 临时通道启动失败：$tunnelText"
        }
    } until ($shareUrl -or (Get-Date) -ge $deadline)
    if (-not $shareUrl) { throw "45 秒内没有获得临时访问地址。请检查网络后重试。" }

    try { Set-Clipboard -Value $shareUrl } catch { }
    Clear-Host
    Write-Host "临时分享已经启动" -ForegroundColor Green
    Write-Host ""
    Write-Host "访问地址：$shareUrl" -ForegroundColor Cyan
    Write-Host "登录账号：$($credential.username)"
    Write-Host "登录密码：$($credential.password)"
    Write-Host ""
    Write-Host "访问地址已复制到剪贴板。把地址、账号和密码发给需要查看的人。"
    Write-Host "关闭本窗口或按 Ctrl+C 即停止分享；地址下次启动时会变化。" -ForegroundColor Yellow
    if (-not $NoBrowser) { Start-Process $shareUrl }

    Wait-Process -Id $tunnelProcess.Id
}
finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
    }
    Stop-ProcessSafely -Process $tunnelProcess
    Stop-ProcessSafely -Process $serverProcess
    Remove-Item -LiteralPath $serverPidPath, $tunnelPidPath -Force -ErrorAction SilentlyContinue
}

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$tempDir = Join-Path $projectRoot "tmp"
$serverPidPath = Join-Path $tempDir "temporary-share-server.pid"
$tunnelPidPath = Join-Path $tempDir "temporary-share-tunnel.pid"
$sharePort = 8766

function Stop-TrackedProcess {
    param(
        [string]$PidPath,
        [string[]]$ExpectedNames,
        [switch]$RequireSharePort
    )
    if (-not (Test-Path -LiteralPath $PidPath)) { return $false }
    $processIdText = (Get-Content -LiteralPath $PidPath -Raw).Trim()
    $trackedPid = 0
    if (-not [int]::TryParse($processIdText, [ref]$trackedPid)) {
        Remove-Item -LiteralPath $PidPath -Force
        return $false
    }
    $process = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
    if ($null -eq $process -or $ExpectedNames -notcontains $process.ProcessName) {
        Remove-Item -LiteralPath $PidPath -Force
        return $false
    }
    if ($RequireSharePort) {
        $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $sharePort -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $trackedPid }
        if (-not $listener) { return $false }
    }
    Stop-Process -Id $trackedPid -Force
    Remove-Item -LiteralPath $PidPath -Force
    return $true
}

$stoppedTunnel = Stop-TrackedProcess -PidPath $tunnelPidPath -ExpectedNames @("cloudflared")
$stoppedServer = Stop-TrackedProcess -PidPath $serverPidPath -ExpectedNames @("python", "pythonw") -RequireSharePort

if ($stoppedTunnel -or $stoppedServer) {
    Write-Host "临时分享已停止。" -ForegroundColor Green
}
else {
    Write-Host "当前没有正在运行的临时分享。" -ForegroundColor Yellow
}

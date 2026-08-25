[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$taskName = "简道云利润数据同步"
$projectRoot = Split-Path -Parent $PSScriptRoot
$syncScript = Join-Path $PSScriptRoot "Sync-JianDaoYun.ps1"
$hiddenLauncher = Join-Path $PSScriptRoot "Run-Sync-Hidden.vbs"
$statusPath = Join-Path $projectRoot "data\scheduled-task.json"
$wscriptExe = Join-Path $env:SystemRoot "System32\wscript.exe"
$userId = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "config\api-key.dpapi"))) {
    throw "尚未设置API Key，请先运行 设置API密钥.cmd。"
}
if (-not (Test-Path -LiteralPath $hiddenLauncher)) {
    throw "缺少后台同步启动器：$hiddenLauncher"
}

Import-Module ScheduledTasks

$arguments = "//B //NoLogo `"$hiddenLauncher`""
$action = New-ScheduledTaskAction -Execute $wscriptExe -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "每5分钟同步简道云申购、销售出库、销售单价和Import tax附件。" -Force | Out-Null

$task = Get-ScheduledTask -TaskName $taskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
$status = [ordered]@{
    task_name = $task.TaskName
    state = [string]$task.State
    user_id = $userId
    execution_mode = "hidden"
    launcher = $hiddenLauncher
    repetition_interval = [string]$task.Triggers[0].Repetition.Interval
    start_boundary = [string]$task.Triggers[0].StartBoundary
    next_run_time = if ($taskInfo.NextRunTime) { $taskInfo.NextRunTime.ToString("o") } else { $null }
    installed_at = (Get-Date).ToString("o")
}
$status | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $statusPath -Encoding UTF8
Write-Host "计划任务安装成功：$($task.TaskName)" -ForegroundColor Green
Write-Host "运行账户：$userId" -ForegroundColor Green
Write-Host "同步频率：每5分钟" -ForegroundColor Green
Write-Host "运行方式：后台静默，不显示PowerShell窗口" -ForegroundColor Green

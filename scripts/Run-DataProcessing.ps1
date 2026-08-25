$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonCandidates = @()
if ($env:USERPROFILE) {
    $pythonCandidates += Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
}
foreach ($commandName in @("python3", "python", "python.exe")) {
    $pythonCommand = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($pythonCommand) { $pythonCandidates += $pythonCommand.Source }
}
$pythonPath = $pythonCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if (-not $pythonPath) {
    throw "未找到 Python，无法生成利润数据。"
}

& $pythonPath (Join-Path $PSScriptRoot "parse_customs_attachments.py")
if ($LASTEXITCODE -ne 0) { throw "报关附件解析失败，退出码：$LASTEXITCODE" }

& $pythonPath (Join-Path $PSScriptRoot "build_profit_data.py")
if ($LASTEXITCODE -ne 0) { throw "利润数据生成失败，退出码：$LASTEXITCODE" }

& $pythonPath (Join-Path $PSScriptRoot "audit_data_integrity.py")
if ($LASTEXITCODE -ne 0) { throw "数据完整性审计失败，退出码：$LASTEXITCODE" }

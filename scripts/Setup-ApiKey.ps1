[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $projectRoot "config"
$keyPath = Join-Path $configDir "api-key.dpapi"

New-Item -ItemType Directory -Force -Path $configDir | Out-Null

Write-Host "请输入简道云 API Key。输入内容不会显示在屏幕上。" -ForegroundColor Cyan
$secureKey = Read-Host "API Key" -AsSecureString

if ($secureKey.Length -eq 0) {
    throw "API Key 不能为空。"
}

$encrypted = ConvertFrom-SecureString -SecureString $secureKey
Set-Content -LiteralPath $keyPath -Value $encrypted -Encoding UTF8

Write-Host "API Key 已使用 Windows DPAPI 加密保存：$keyPath" -ForegroundColor Green
Write-Host "只有当前 Windows 用户可以解密。" -ForegroundColor Green


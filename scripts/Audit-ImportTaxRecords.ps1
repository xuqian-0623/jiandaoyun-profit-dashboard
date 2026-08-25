[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$projectRoot = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $projectRoot "config\settings.json"
$settings = [IO.File]::ReadAllText($settingsPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$encrypted = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot "config\api-key.dpapi")).Trim()
$secure = ConvertTo-SecureString -String $encrypted
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

$headers = @{
    Authorization = "Bearer $apiKey"
    "Content-Type" = "application/json"
}
$purchase = @($settings.datasets | Where-Object name -eq "purchases")[0]
$records = @()
$cursor = $null

do {
    $body = [ordered]@{
        app_id = [string]$settings.app_id
        entry_id = [string]$purchase.entry_id
        limit = 100
        fields = @(
            "_widget_1517542638161",
            "_widget_1517542638204",
            "_widget_1727337817607",
            "_widget_1727337817611",
            "_widget_1517558654967",
            "flowState"
        )
    }
    if ($cursor) { $body.data_id = $cursor }

    $response = Invoke-RestMethod `
        -Method Post `
        -Uri $settings.api_url `
        -Headers $headers `
        -Body ($body | ConvertTo-Json -Depth 20 -Compress) `
        -TimeoutSec 90
    $items = @($response.data)
    $records += $items
    $cursor = if ($items.Count -eq 100) { [string]$items[-1]._id } else { $null }
}
while ($cursor)

$imports = @($records | Where-Object {
    ([string]$_.'_widget_1727337817607') -match '(?i)import\s*tax'
})

$summary = foreach ($record in $imports) {
    $attachments = @($record.'_widget_1727337817611')
    [pscustomobject]@{
        number = [string]$record.'_widget_1517542638161'
        date = [string]$record.'_widget_1517542638204'
        flow = [string]$record.flowState
        pay_status = [string]$record.'_widget_1517558654967'
        item = [string]$record.'_widget_1727337817607'
        attachment_count = $attachments.Count
        formats = (($attachments | ForEach-Object {
            [IO.Path]::GetExtension([string]$_.name).ToLowerInvariant()
        }) -join ",")
        names = (($attachments | ForEach-Object { [string]$_.name }) -join " | ")
    }
}

[pscustomobject]@{
    api_total = $records.Count
    import_records = $imports.Count
    rows = @($summary | Sort-Object date -Descending)
} | ConvertTo-Json -Depth 8

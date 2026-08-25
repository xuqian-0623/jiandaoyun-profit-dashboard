[CmdletBinding()]
param(
    [switch]$SkipAttachments,
    [int]$MaxPages = 10000
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$projectRoot = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $projectRoot "config\settings.json"
$keyPath = Join-Path $projectRoot "config\api-key.dpapi"
$rawDir = Join-Path $projectRoot "data\raw"
$attachmentDir = Join-Path $projectRoot "data\attachments"
$manifestPath = Join-Path $attachmentDir "manifest.json"
$statePath = Join-Path $projectRoot "data\sync-state.json"
$errorPath = Join-Path $projectRoot "data\last-error.json"
$logDir = Join-Path $projectRoot "logs"
$logPath = Join-Path $logDir ("sync-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

New-Item -ItemType Directory -Force -Path $rawDir, $attachmentDir, $logDir | Out-Null

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Write-JsonAtomic {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$Path)
    $tempPath = "$Path.tmp"
    ConvertTo-Json -InputObject $Value -Depth 100 | Set-Content -LiteralPath $tempPath -Encoding UTF8
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
}

function Get-DynamicValue {
    param([Parameter(Mandatory)]$Object, [Parameter(Mandatory)][string]$Name)
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-ApiKey {
    $environmentKey = [string]$env:JIANDAOYUN_API_KEY
    if (-not [string]::IsNullOrWhiteSpace($environmentKey)) {
        return $environmentKey.Trim()
    }

    if (-not (Test-Path -LiteralPath $keyPath)) {
        throw "尚未设置 API Key。服务器请设置 JIANDAOYUN_API_KEY 环境变量，本机请运行 scripts\Setup-ApiKey.ps1。"
    }

    $encrypted = (Get-Content -LiteralPath $keyPath -Raw -Encoding UTF8).Trim()
    $secure = ConvertTo-SecureString -String $encrypted
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Invoke-WithRetry {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [string]$Description = "请求",
        [int]$Attempts = 4
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            return & $Action
        }
        catch {
            if ($attempt -eq $Attempts) { throw }
            $delay = [Math]::Pow(2, $attempt)
            Write-Log "$Description 失败，第 $attempt 次重试前等待 $delay 秒：$($_.Exception.Message)" "WARN"
            Start-Sleep -Seconds $delay
        }
    }
}

function Get-AllRecords {
    param(
        [Parameter(Mandatory)]$Dataset,
        [Parameter(Mandatory)][string]$ApiKey,
        [Parameter(Mandatory)]$Settings
    )

    $recordsById = @{}
    $cursor = $null
    $page = 0
    $headers = @{
        Authorization = "Bearer $ApiKey"
        "Content-Type" = "application/json"
    }

    while ($true) {
        $page++
        if ($page -gt $MaxPages) {
            throw "数据集 $($Dataset.name) 超过安全页数上限 $MaxPages。"
        }

        $body = [ordered]@{
            app_id = [string]$Settings.app_id
            entry_id = [string]$Dataset.entry_id
            limit = [int]$Settings.page_size
            fields = @($Dataset.fields)
        }
        if ($Dataset.PSObject.Properties.Name -contains "filter") {
            $body.filter = $Dataset.filter
        }
        if ($cursor) {
            $body.data_id = $cursor
        }

        $jsonBody = $body | ConvertTo-Json -Depth 30 -Compress
        $response = Invoke-WithRetry -Description "$($Dataset.name) 第 $page 页" -Action {
            Invoke-RestMethod -Method Post -Uri $Settings.api_url -Headers $headers -Body $jsonBody -TimeoutSec 90
        }

        $items = @($response.data)
        foreach ($item in $items) {
            if ($item._id) {
                $recordsById[[string]$item._id] = $item
            }
        }

        Write-Log "$($Dataset.name)：第 $page 页返回 $($items.Count) 条，累计去重后 $($recordsById.Count) 条。"

        if ($items.Count -lt [int]$Settings.page_size) { break }
        $nextCursor = [string]$items[-1]._id
        if (-not $nextCursor -or $nextCursor -eq $cursor) {
            throw "数据集 $($Dataset.name) 的分页游标未变化，已停止以防死循环。"
        }
        $cursor = $nextCursor
    }

    return @($recordsById.Values)
}

function Select-LocalRecords {
    param(
        [Parameter(Mandatory)]$Dataset,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Records
    )

    if ($Dataset.PSObject.Properties.Name -notcontains "local_filter") {
        return @($Records)
    }

    $selected = @()
    foreach ($record in $Records) {
        $matches = @()
        foreach ($condition in @($Dataset.local_filter.cond)) {
            $actual = Get-DynamicValue -Object $record -Name ([string]$condition.field)
            $expected = $condition.value
            $conditionMatches = $false
            switch ([string]$condition.method) {
                "eq" {
                    $conditionMatches = [string]$actual -ceq [string]$expected
                }
                "starts_with" {
                    $conditionMatches = ([string]$actual).StartsWith([string]$expected, [StringComparison]::Ordinal)
                }
                "not_eq" {
                    $conditionMatches = [string]$actual -cne [string]$expected
                }
                default {
                    throw "不支持的本地筛选方式：$($condition.method)"
                }
            }
            $matches += $conditionMatches
        }

        $include = if ([string]$Dataset.local_filter.rel -eq "or") {
            $matches -contains $true
        }
        else {
            $matches -notcontains $false
        }
        if ($include) { $selected += $record }
    }
    return @($selected)
}

function Get-AttachmentManifest {
    $entries = @()
    if (Test-Path -LiteralPath $manifestPath) {
        $loaded = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $loaded) { $entries = @($loaded) }
    }
    return $entries
}

function Save-NewAttachments {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Records,
        [Parameter(Mandatory)]$AttachmentSettings
    )

    $manifest = @(Get-AttachmentManifest)
    $allowedFields = @{}
    foreach ($field in @($AttachmentSettings.fields)) {
        $allowedFields[[string]$field] = $true
    }
    $filteredManifest = @()
    foreach ($entry in $manifest) {
        $allowedSourceKeys = @(
            @($entry.source_keys) | Where-Object {
                $parts = [string]$_ -split '\|', 3
                $parts.Count -ge 2 -and $allowedFields.ContainsKey($parts[1])
            }
        )
        if ($allowedSourceKeys.Count -eq 0) { continue }
        $entry.source_keys = $allowedSourceKeys
        $entry.source_record_ids = @(
            $allowedSourceKeys | ForEach-Object { ([string]$_ -split '\|', 3)[0] } | Select-Object -Unique
        )
        $filteredManifest += $entry
    }
    $manifest = $filteredManifest
    $byHash = @{}
    $knownSourceKeys = @{}
    foreach ($entry in $manifest) {
        $byHash[[string]$entry.sha256] = $entry
        foreach ($sourceKey in @($entry.source_keys)) {
            if ($sourceKey) { $knownSourceKeys[[string]$sourceKey] = $true }
        }
    }

    $downloaded = 0
    $duplicates = 0
    $skipped = 0
    $failed = 0
    $itemField = [string]$AttachmentSettings.item_field
    $attachmentFields = @($AttachmentSettings.fields)
    $needle = [string]$AttachmentSettings.item_contains

    foreach ($record in $Records) {
        $itemText = [string](Get-DynamicValue -Object $record -Name $itemField)
        if ($itemText.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }

        foreach ($attachmentField in $attachmentFields) {
            $recordAttachments = Get-DynamicValue -Object $record -Name ([string]$attachmentField)
            foreach ($attachment in @($recordAttachments)) {
            if ($null -eq $attachment -or -not $attachment.url) { continue }
            $stableUrl = ([string]$attachment.url).Split('?')[0]
            $sourceKey = "{0}|{1}|{2}" -f [string]$record._id, [string]$attachmentField, $stableUrl
            if ($knownSourceKeys.ContainsKey($sourceKey)) {
                $skipped++
                continue
            }

            $tempPath = Join-Path $attachmentDir ("incoming-{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
            try {
                Invoke-WithRetry -Description "下载附件 $($attachment.name)" -Action {
                    Invoke-WebRequest -Uri ([string]$attachment.url) -OutFile $tempPath -TimeoutSec 180 -UseBasicParsing
                } | Out-Null

                $hash = (Get-FileHash -LiteralPath $tempPath -Algorithm SHA256).Hash.ToLowerInvariant()
                $extension = [IO.Path]::GetExtension([string]$attachment.name)
                if (-not $extension -or $extension -notmatch '^\.[A-Za-z0-9]{1,10}$') { $extension = ".bin" }
                $relativePath = "$hash$($extension.ToLowerInvariant())"
                $finalPath = Join-Path $attachmentDir $relativePath

                if (Test-Path -LiteralPath $finalPath) {
                    Remove-Item -LiteralPath $tempPath -Force
                    $duplicates++
                }
                else {
                    Move-Item -LiteralPath $tempPath -Destination $finalPath
                    $downloaded++
                }

                if ($byHash.ContainsKey($hash)) {
                    $entry = $byHash[$hash]
                    $entry.source_keys = @(@($entry.source_keys) + $sourceKey | Select-Object -Unique)
                    $entry.original_names = @(@($entry.original_names) + [string]$attachment.name | Select-Object -Unique)
                    $entry.source_record_ids = @(@($entry.source_record_ids) + [string]$record._id | Select-Object -Unique)
                }
                else {
                    $entry = [PSCustomObject]@{
                        sha256 = $hash
                        path = $relativePath
                        size = [long](Get-Item -LiteralPath $finalPath).Length
                        mime = [string]$attachment.mime
                        original_names = @([string]$attachment.name)
                        source_keys = @($sourceKey)
                        source_record_ids = @([string]$record._id)
                        first_seen_utc = [DateTime]::UtcNow.ToString("o")
                    }
                    $manifest += $entry
                    $byHash[$hash] = $entry
                }
                $knownSourceKeys[$sourceKey] = $true
            }
            catch {
                $failed++
                if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
                Write-Log "附件下载失败：$($attachment.name)；$($_.Exception.Message)" "WARN"
            }
            }
        }
    }

    Write-JsonAtomic -Value $manifest -Path $manifestPath
    return [PSCustomObject]@{
        downloaded = $downloaded
        duplicate_content = $duplicates
        already_known = $skipped
        failed = $failed
        unique_files = $manifest.Count
    }
}

try {
    Write-Log "开始同步简道云数据。"
    $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $apiKey = Get-ApiKey
    $fetched = @{}
    $counts = [ordered]@{}
    $apiCounts = [ordered]@{}

    foreach ($dataset in @($settings.datasets)) {
        $apiRecords = @(Get-AllRecords -Dataset $dataset -ApiKey $apiKey -Settings $settings)
        $records = @(Select-LocalRecords -Dataset $dataset -Records $apiRecords)
        $fetched[[string]$dataset.name] = $records
        $apiCounts[[string]$dataset.name] = $apiRecords.Count
        $counts[[string]$dataset.name] = $records.Count
        if ($apiRecords.Count -ne $records.Count) {
            Write-Log "$($dataset.name)：本地业务筛选后保留 $($records.Count) / $($apiRecords.Count) 条。"
        }
    }

    $attachmentStats = [PSCustomObject]@{
        downloaded = 0
        duplicate_content = 0
        already_known = 0
        failed = 0
        unique_files = 0
    }
    if (-not $SkipAttachments) {
        $attachmentStats = Save-NewAttachments -Records @($fetched[[string]$settings.attachments.dataset]) -AttachmentSettings $settings.attachments
    }

    foreach ($dataset in @($settings.datasets)) {
        $outputPath = Join-Path $rawDir ("{0}.json" -f [string]$dataset.name)
        Write-JsonAtomic -Value ([ordered]@{ data = @($fetched[[string]$dataset.name]) }) -Path $outputPath
    }

    $state = [ordered]@{
        status = "success"
        last_success_utc = [DateTime]::UtcNow.ToString("o")
        api_counts = $apiCounts
        counts = $counts
        attachments = $attachmentStats
        processing = [ordered]@{
            status = "pending"
        }
    }
    Write-JsonAtomic -Value $state -Path $statePath

    try {
        & (Join-Path $PSScriptRoot "Run-DataProcessing.ps1")
        $state.processing = [ordered]@{
            status = "success"
            completed_utc = [DateTime]::UtcNow.ToString("o")
        }
    }
    catch {
        $state.processing = [ordered]@{
            status = "failed"
            failed_utc = [DateTime]::UtcNow.ToString("o")
            message = $_.Exception.Message
        }
        Write-Log "利润数据处理失败，网页继续保留上一次成功结果：$($_.Exception.Message)" "WARN"
    }
    Write-JsonAtomic -Value $state -Path $statePath
    if (Test-Path -LiteralPath $errorPath) { Remove-Item -LiteralPath $errorPath -Force }
    Write-Log ("同步成功。purchases={0}, outbound={1}, prices={2}, 新附件={3}, 附件失败={4}" -f $counts.purchases, $counts.outbound, $counts.prices, $attachmentStats.downloaded, $attachmentStats.failed)
}
catch {
    $errorState = [ordered]@{
        status = "failed"
        failed_utc = [DateTime]::UtcNow.ToString("o")
        message = $_.Exception.Message
    }
    Write-JsonAtomic -Value $errorState -Path $errorPath
    Write-Log "同步失败，已保留上一次成功数据：$($_.Exception.Message)" "ERROR"
    exit 1
}
finally {
    $apiKey = $null
}

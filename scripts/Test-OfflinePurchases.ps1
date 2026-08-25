[CmdletBinding()]
param(
    [Parameter(Mandatory)][string[]]$Files
)

$ErrorActionPreference = "Stop"
$recordsById = @{}

foreach ($file in $Files) {
    $json = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($record in @($json.data)) {
        if ($record._id) { $recordsById[[string]$record._id] = $record }
    }
}

$all = @($recordsById.Values)
$paid = @($all | Where-Object {
    $_.flowState -eq 1 -and [string]($_.'_widget_1517558654967') -like "PAYMENT SUCCESS/*"
})
$importTax = @($paid | Where-Object {
    [string]($_.'_widget_1727337817607') -match '(?i)Import\s*tax'
})

[PSCustomObject]@{
    files = $Files.Count
    unique_records = $all.Count
    payment_success_records = $paid.Count
    payment_success_amount = [Math]::Round((($paid | Measure-Object -Property '_widget_1727337817617' -Sum).Sum), 2)
    import_tax_records = $importTax.Count
    import_tax_amount = [Math]::Round((($importTax | Measure-Object -Property '_widget_1727337817617' -Sum).Sum), 2)
    import_tax_attachments = @($importTax | ForEach-Object { @($_.'_widget_1727337817611') }).Count
} | ConvertTo-Json -Depth 10

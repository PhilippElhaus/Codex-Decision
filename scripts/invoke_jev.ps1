param(
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Codex\jev-output-pilot')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$requestBytes = $null
$keyBytes = $null
$failure = 'JEV_UNAVAILABLE'
try {
    $encoded = [Console]::In.ReadToEnd().Trim()
    if ($encoded.Length -eq 0 -or $encoded.Length -gt 90000) { throw 'Invalid request size.' }
    $requestBytes = [System.Convert]::FromBase64String($encoded)
    if ($requestBytes.Length -gt 65536) { throw 'Invalid request size.' }
    $keyPath = Join-Path ([System.IO.Path]::GetFullPath($StateDirectory)) 'key.dpapi'
    if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
        $failure = 'JEV_KEY_CACHE_MISSING'
        throw 'Jev key cache is missing.'
    }
    $encrypted = [System.IO.File]::ReadAllBytes($keyPath)
    $keyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    $key = ([System.Text.Encoding]::UTF8.GetString($keyBytes)).Trim()
    if ($key.Length -lt 8 -or $key.Length -gt 4096 -or $key -match '[\r\n\x00]') {
        $failure = 'JEV_API_KEY_INVALID'
        throw 'Invalid cached Jev key.'
    }
    $headers = @{ Authorization = ('Bearer ' + $key) }
    $response = Invoke-WebRequest -Uri 'https://api.typesafe.ai/v1/systemone' -Method Post `
        -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $requestBytes `
        -TimeoutSec 3 -UseBasicParsing
    if ($response.Content.Length -gt 262144) {
        $failure = 'JEV_RESPONSE_TOO_LARGE'
        throw 'Jev response is too large.'
    }
    [Console]::Out.WriteLine($response.Content)
} catch {
    $status = $_.Exception.Response.StatusCode
    if ($status -ne $null) { $failure = 'JEV_HTTP_' + [int]$status }
    [Console]::Error.WriteLine($failure)
    exit 1
} finally {
    if ($requestBytes -ne $null) { [System.Array]::Clear($requestBytes, 0, $requestBytes.Length) }
    if ($keyBytes -ne $null) { [System.Array]::Clear($keyBytes, 0, $keyBytes.Length) }
}

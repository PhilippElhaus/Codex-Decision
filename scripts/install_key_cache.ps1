param(
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Codex\jev-output-pilot')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stateRoot = [System.IO.Path]::GetFullPath($StateDirectory)
if ([System.IO.Path]::GetPathRoot($tempRoot) -ieq 'D:\' -or
    [System.IO.Path]::GetPathRoot($stateRoot) -ieq 'D:\') {
    throw 'Jev credential materialization and state must stay off D:.'
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$work = Join-Path $tempRoot ('codex-jev-key-' + [guid]::NewGuid().ToString('N'))
$materialized = Join-Path $work 'secret'
$bytes = $null
$clear = $null
try {
    New-Item -ItemType Directory -Path $work -ErrorAction Stop | Out-Null
    & icacls.exe $work '/inheritance:r' '/grant:r' "$($identity):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect temporary Jev credential directory.' }

    $helper = 'D:\Vaultwarden\scripts\vaultwarden-local.ps1'
    & $helper materialize -CollectionName OpenClaw -Name typesafe-api-key -OutputPath $materialized | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $materialized -PathType Leaf)) {
        throw 'Vaultwarden did not materialize the Jev key.'
    }
    $bytes = [System.IO.File]::ReadAllBytes($materialized)
    $key = ([System.Text.Encoding]::UTF8.GetString($bytes)).Trim()
    if ($key.Length -lt 8 -or $key.Length -gt 4096 -or $key -match '[\r\n\x00]') {
        throw 'Vaultwarden returned an invalid Jev key.'
    }
    $clear = [System.Text.Encoding]::UTF8.GetBytes($key)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
        $clear, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)

    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    $directory = Get-Item -LiteralPath $stateRoot -Force
    if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Jev state directory is a link.'
    }
    & icacls.exe $stateRoot '/inheritance:r' '/grant:r' "$($identity):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect Jev state directory.' }

    $keyPath = Join-Path $stateRoot 'key.dpapi'
    $keyTemp = Join-Path $stateRoot ('key-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [System.IO.File]::WriteAllBytes($keyTemp, $protected)
    & icacls.exe $keyTemp '/inheritance:r' '/grant:r' "$($identity):F" 'SYSTEM:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect Jev key cache.' }
    [System.IO.File]::Move($keyTemp, $keyPath, $true)

    $scriptPath = Join-Path $stateRoot 'invoke_jev.ps1'
    $scriptSource = Join-Path $PSScriptRoot 'invoke_jev.ps1'
    if ([System.IO.Path]::GetFullPath($scriptSource) -ine [System.IO.Path]::GetFullPath($scriptPath)) {
        $scriptTemp = Join-Path $stateRoot ('invoke-' + [guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::Copy($scriptSource, $scriptTemp)
        [System.IO.File]::Move($scriptTemp, $scriptPath, $true)
    }
    $refreshPath = Join-Path $stateRoot 'refresh_key_cache.ps1'
    if ([System.IO.Path]::GetFullPath($PSCommandPath) -ine [System.IO.Path]::GetFullPath($refreshPath)) {
        $refreshTemp = Join-Path $stateRoot ('refresh-' + [guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::Copy($PSCommandPath, $refreshTemp)
        [System.IO.File]::Move($refreshTemp, $refreshPath, $true)
    }
    Write-Output '{"state":"ready"}'
} finally {
    if ($bytes -ne $null) { [System.Array]::Clear($bytes, 0, $bytes.Length) }
    if ($clear -ne $null) { [System.Array]::Clear($clear, 0, $clear.Length) }
    foreach ($pending in @($keyTemp, $scriptTemp, $refreshTemp)) {
        if ($pending -and (Test-Path -LiteralPath $pending -PathType Leaf)) {
            $item = Get-Item -LiteralPath $pending -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Temporary Jev state file is a link; cleanup requires inspection.'
            }
            Remove-Item -LiteralPath $pending -Force
        }
    }
    if (Test-Path -LiteralPath $work) {
        $item = Get-Item -LiteralPath $work -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            (Get-ChildItem -LiteralPath $work -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)) {
            throw 'Temporary Jev credential directory contains a link; cleanup requires inspection.'
        }
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}

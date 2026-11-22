$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'resolve-nahida.ps1')

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function global:Resolve-DnsName {
    param($Name, $Type, [switch]$DnsOnly)
    $global:dnsCalls++
    if ($global:dnsFailure) { throw 'Mock DNS failure' }
    return $global:dnsRecords
}

function global:ssh {
    $global:sshCalls += ,@($args)
    $target = @($args | Where-Object { $_ -like 'throndir@*' }) | Select-Object -First 1
    $global:LASTEXITCODE = if ($target -in $global:sshSuccess) { 0 } else { 255 }
}

function global:scp {
    $global:scpCalls += ,@($args)
    $global:LASTEXITCODE = 0
}

function global:Invoke-RestMethod {
    param($Uri, $Method, $Headers, $ContentType, $TimeoutSec, $Body)
    $global:apiCalls += ,@($Uri, $Method, $Body)
    if ($Uri -like '*/api/tokens') { return @{ token = 'mock-token' } }
    if ($Uri -like '*/api/nginx/certificates') { return @() }
    if ($Method -eq 'GET') { return @() }
    return @{ id = 1 }
}

function Reset-Mocks {
    $global:dnsCalls = 0
    $global:dnsFailure = $false
    $global:dnsRecords = @()
    $global:sshCalls = @()
    $global:scpCalls = @()
    $global:sshSuccess = @()
    $global:apiCalls = @()
}

function Assert-Pinned([object[]]$Call) {
    foreach ($option in @('BatchMode=yes', 'StrictHostKeyChecking=yes', 'HostKeyAlias=[192.168.50.9]:9222', 'ConnectTimeout=3')) {
        Assert-True ($Call -contains $option) "Missing SSH option: $option"
    }
}

$oldIdentity = $env:NPM_IDENTITY
$oldSecret = $env:NPM_SECRET
try {
    $env:NPM_IDENTITY = 'mock'
    $env:NPM_SECRET = 'mock'

    Reset-Mocks
    $global:dnsRecords = @(
        @{ Type = 'A'; IPAddress = '192.168.50.0' },
        @{ Type = 'A'; IPAddress = '192.168.50.255' },
        @{ Type = 'A'; IPAddress = '192.168.51.1' },
        @{ Type = 'A'; IPAddress = '192.168.50.114' },
        @{ Type = 'A'; IPAddress = '192.168.50.114' }
    )
    $global:sshSuccess = @('throndir@192.168.50.114')
    Assert-True ((Resolve-NahidaAddress) -eq '192.168.50.114') 'DNS address was not selected.'
    Assert-True ($global:sshCalls.Count -eq 1) 'Invalid or duplicate DNS addresses were probed.'
    Assert-Pinned $global:sshCalls[0]

    Reset-Mocks
    $global:dnsFailure = $true
    $global:sshSuccess = @('throndir@192.168.50.9')
    Assert-True ((Resolve-NahidaAddress) -eq '192.168.50.9') 'Fallback address was not selected.'
    Assert-True ($global:sshCalls.Count -eq 2) 'Fallback candidates were not tried in order.'
    Assert-True ($global:sshCalls[0] -contains 'throndir@192.168.50.114') 'First fallback was wrong.'
    Assert-Pinned $global:sshCalls[1]

    Reset-Mocks
    $global:dnsRecords = @(
        @{ Type = 'A'; IPAddress = '192.168.50.114' },
        @{ Type = 'A'; IPAddress = '192.168.50.114' }
    )
    $global:sshSuccess = @('throndir@192.168.50.9')
    Assert-True ((Resolve-NahidaAddress) -eq '192.168.50.9') 'A failed DNS candidate did not reach the fallback.'
    Assert-True ($global:sshCalls.Count -eq 2) 'The failed DNS candidate was checked more than once.'

    Reset-Mocks
    try {
        Resolve-NahidaAddress -NahidaHost '192.168.50.10' | Out-Null
        throw 'An unreachable explicit host was accepted.'
    } catch {
        Assert-True ($_.Exception.Message -like 'No Nahida address passed*') 'The explicit host did not fail safely.'
    }
    Assert-True ($global:sshCalls.Count -eq 1) 'An explicit host fell back to another address.'

    Reset-Mocks
    try {
        & (Join-Path $PSScriptRoot 'deploy-nahida.ps1') -NahidaHost '192.168.50.10' -Rollback 'test'
        throw 'Deployment accepted an unreachable host.'
    } catch {
        Assert-True ($_.Exception.Message -like 'No Nahida address passed*') 'Deployment did not fail before writes.'
    }
    Assert-True ($global:scpCalls.Count -eq 0 -and $global:sshCalls.Count -eq 1) 'Deployment attempted a write.'

    Reset-Mocks
    $global:dnsRecords = @(@{ Type = 'A'; IPAddress = '192.168.50.114' })
    $global:sshSuccess = @('throndir@192.168.50.114')
    & (Join-Path $PSScriptRoot 'deploy-nahida.ps1') -Rollback 'test' | Out-Null
    Assert-True ($global:scpCalls.Count -eq 1) 'Mock deployment did not upload the Compose file.'
    foreach ($call in $global:sshCalls) { Assert-Pinned $call }
    Assert-Pinned $global:scpCalls[0]
    $remotePayloads = @($global:sshCalls | ForEach-Object {
        $command = $_[-1]
        if ($command -match '^echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh$') {
            [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1]))
        }
    })
    Assert-True (($remotePayloads -join "`n") -match 'MCV_BIND_ADDRESS=192\.168\.50\.114') 'The deploy bind address did not follow discovery.'

    Reset-Mocks
    $global:sshSuccess = @('throndir@192.168.50.9')
    & (Join-Path $PSScriptRoot 'deploy-nahida.ps1') -NahidaHost '192.168.50.9' -BindAddress '127.0.0.1' -Rollback 'test' | Out-Null
    $remotePayloads = @($global:sshCalls | ForEach-Object {
        if ($_[-1] -match '^echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh$') {
            [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1]))
        }
    })
    Assert-True (($remotePayloads -join "`n") -match 'MCV_BIND_ADDRESS=127\.0\.0\.1') 'The explicit bind address changed.'
    Assert-True ($global:dnsCalls -eq 0) 'The explicit SSH address used discovery.'

    Reset-Mocks
    $global:dnsRecords = @(@{ Type = 'A'; IPAddress = '192.168.50.114' })
    $global:sshSuccess = @('throndir@192.168.50.114')
    & (Join-Path $PSScriptRoot 'configure-npm.ps1') -NoCertificate | Out-Null
    Assert-True ($global:apiCalls[0][0] -eq 'http://192.168.50.114:81/api/tokens') 'The proxy URL did not follow discovery.'
    $payload = $global:apiCalls[-1][2] | ConvertFrom-Json
    Assert-True ($payload.forward_host -eq '192.168.50.114') 'The proxy upstream did not follow discovery.'

    Reset-Mocks
    $global:sshSuccess = @('throndir@192.168.50.9')
    & (Join-Path $PSScriptRoot 'configure-npm.ps1') -ProxyManagerUrl 'http://192.168.50.9:81' -NoCertificate | Out-Null
    Assert-True ($global:apiCalls[0][0] -eq 'http://192.168.50.9:81/api/tokens') 'The explicit Nahida proxy URL changed.'
    Assert-True (($global:apiCalls[-1][2] | ConvertFrom-Json).forward_host -eq '192.168.50.9') 'The proxy upstream did not follow the explicit Nahida URL.'

    Reset-Mocks
    & (Join-Path $PSScriptRoot 'configure-npm.ps1') -ProxyManagerUrl 'http://proxy.example:81' -ForwardHost 'app.example' -NoCertificate | Out-Null
    Assert-True ($global:dnsCalls -eq 0 -and $global:sshCalls.Count -eq 0) 'External proxy settings unexpectedly used discovery.'
    Assert-True ($global:apiCalls[0][0] -eq 'http://proxy.example:81/api/tokens') 'The external proxy URL changed.'
    Assert-True (($global:apiCalls[-1][2] | ConvertFrom-Json).forward_host -eq 'app.example') 'The external upstream changed.'

    Reset-Mocks
    try {
        & (Join-Path $PSScriptRoot 'configure-npm.ps1') -ProxyManagerUrl 'http://192.168.50.9:81' -ForwardHost '192.168.50.9' -NoCertificate
        throw 'The proxy script accepted an unreachable Nahida host.'
    } catch {
        Assert-True ($_.Exception.Message -like 'No Nahida address passed*') 'The proxy script did not fail safely.'
    }
    Assert-True ($global:apiCalls.Count -eq 0) 'The proxy script sent an API request before verification.'
    Write-Host 'Nahida discovery checks passed.'
} finally {
    $env:NPM_IDENTITY = $oldIdentity
    $env:NPM_SECRET = $oldSecret
    Remove-Item function:\Resolve-DnsName, function:\ssh, function:\scp, function:\Invoke-RestMethod -ErrorAction SilentlyContinue
}

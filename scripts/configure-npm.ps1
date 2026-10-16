<#
.SYNOPSIS
    Creates or updates the Nginx Proxy Manager host for Multiplayer Choicer Voicer.

.DESCRIPTION
    Signs in to Nginx Proxy Manager, finds or requests a TLS certificate for the domain,
    and creates or updates a proxy host that forwards to the container on Nahida with
    WebSocket upgrades on. The login comes from the NPM_IDENTITY and NPM_SECRET
    environment variables, or from a prompt. It is never stored or printed.

    Run this after scripts/deploy-nahida.ps1 reports a healthy upstream and after the
    Cloudflare DNS record for the domain exists.

.EXAMPLE
    pwsh -File scripts/configure-npm.ps1

.EXAMPLE
    pwsh -File scripts/configure-npm.ps1 -Domain choicervoicer.example.com -NoCertificate
#>
[CmdletBinding()]
param(
    [string]$ProxyManagerUrl = 'http://192.168.50.9:81',
    [string]$Domain = 'choicervoicer.throndir.com',
    [string]$ForwardHost = '192.168.50.9',
    [int]$ForwardPort = 3090,
    [switch]$NoCertificate,
    [string]$LetsEncryptEmail
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-ProxyManagerApi {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Method = 'GET',
        $Body,
        [string]$Token,
        [int]$TimeoutSec = 30
    )
    $headers = @{ Accept = 'application/json' }
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }
    $parameters = @{
        Uri         = "$ProxyManagerUrl$Path"
        Method      = $Method
        Headers     = $headers
        ContentType = 'application/json'
        TimeoutSec  = $TimeoutSec
    }
    if ($null -ne $Body) { $parameters['Body'] = ($Body | ConvertTo-Json -Depth 10 -Compress) }
    return Invoke-RestMethod @parameters
}

Write-Step "Signing in to Nginx Proxy Manager at $ProxyManagerUrl"
$identity = $env:NPM_IDENTITY
$secret = $env:NPM_SECRET
if (-not $identity) { $identity = Read-Host 'Nginx Proxy Manager email' }
if (-not $secret) {
    $secure = Read-Host 'Nginx Proxy Manager password' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
$tokenResponse = Invoke-ProxyManagerApi -Path '/api/tokens' -Method 'POST' -Body @{ identity = $identity; secret = $secret }
$secret = $null
$token = $tokenResponse.token
if (-not $token) { throw 'Nginx Proxy Manager did not return a token. Check the login and try again.' }
Write-Host '    signed in'

Write-Step "Looking for a certificate that covers $Domain"
$certificates = @(Invoke-ProxyManagerApi -Path '/api/nginx/certificates' -Token $token)
$wildcard = '*.' + ($Domain -replace '^[^.]+\.', '')
$match = $certificates | Where-Object { $_.domain_names -contains $Domain -or $_.domain_names -contains $wildcard } | Select-Object -First 1

$certificateId = 0
if ($match) {
    $certificateId = $match.id
    Write-Host "    using certificate $($match.id) for $($match.domain_names -join ', ')"
} elseif (-not $NoCertificate) {
    if (-not $LetsEncryptEmail) { $LetsEncryptEmail = if ($identity -like '*@*') { $identity } else { 'mozart2b@gmail.com' } }
    Write-Step "Requesting a Let's Encrypt certificate for $Domain"
    $created = Invoke-ProxyManagerApi -Path '/api/nginx/certificates' -Method 'POST' -Token $token -TimeoutSec 180 -Body @{
        provider     = 'letsencrypt'
        nice_name    = $Domain
        domain_names = @($Domain)
        meta         = @{ letsencrypt_email = $LetsEncryptEmail; letsencrypt_agree = $true; dns_challenge = $false }
    }
    $certificateId = $created.id
    Write-Host "    issued certificate $certificateId"
} else {
    Write-Warning "No certificate covers $Domain. The host is created without TLS."
}

Write-Step "Creating or updating the proxy host for $Domain"
$existingHosts = @(Invoke-ProxyManagerApi -Path '/api/nginx/proxy-hosts' -Token $token)
$existing = $existingHosts | Where-Object { $_.domain_names -contains $Domain } | Select-Object -First 1

$payload = @{
    domain_names            = @($Domain)
    forward_scheme          = 'http'
    forward_host            = $ForwardHost
    forward_port            = $ForwardPort
    allow_websocket_upgrade = $true
    block_exploits          = $true
    caching_enabled         = $false
    http2_support           = $true
    enabled                 = $true
    certificate_id          = $certificateId
    ssl_forced              = [bool]$certificateId
    hsts_enabled            = [bool]$certificateId
    hsts_subdomains         = $false
    access_list_id          = 0
    # Uploads arrive in 8 MB parts and recordings are small, but long renders and slow
    # connections need generous timeouts.
    advanced_config         = "client_max_body_size 64m;`nproxy_read_timeout 300s;`nproxy_send_timeout 300s;"
    locations               = @()
    meta                    = @{ letsencrypt_agree = $false; dns_challenge = $false }
}

if ($existing) {
    $result = Invoke-ProxyManagerApi -Path "/api/nginx/proxy-hosts/$($existing.id)" -Method 'PUT' -Token $token -Body $payload
    Write-Host "    updated proxy host $($result.id)"
} else {
    $result = Invoke-ProxyManagerApi -Path '/api/nginx/proxy-hosts' -Method 'POST' -Token $token -Body $payload
    Write-Host "    created proxy host $($result.id)"
}

Write-Host ''
Write-Host "Proxy host ready for $Domain" -ForegroundColor Green
Write-Host "  upstream   http://${ForwardHost}:${ForwardPort}"
Write-Host '  websockets on'
Write-Host "  tls        $(if ($certificateId) { "certificate $certificateId, forced" } else { 'not configured' })"

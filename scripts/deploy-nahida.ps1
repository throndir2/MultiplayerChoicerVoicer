<#
.SYNOPSIS
    Builds, transfers, and releases Multiplayer Choicer Voicer on the Nahida Docker host.

.DESCRIPTION
    The script builds an immutable image on this workstation, copies it to Nahida over
    SSH, and starts the Compose project at the remote root. No container registry and no
    GitHub Actions minutes are used. Old image tags stay on the host for a rollback.

.EXAMPLE
    pwsh -File scripts/deploy-nahida.ps1

.EXAMPLE
    pwsh -File scripts/deploy-nahida.ps1 -Rollback 0.1.0-20261015-1530-a1b2c3d

.EXAMPLE
    pwsh -File scripts/deploy-nahida.ps1 -Logs -Tail 400
#>
[CmdletBinding()]
param(
    [string]$NahidaHost = '192.168.50.9',
    [int]$SshPort = 9222,
    [string]$SshUser = 'throndir',
    [string]$RemoteRoot = '/Volume2/apps/multiplayer-choicer-voicer',
    [string]$RemoteDockerBin = '/Volume2/@apps/DockerEngine/dockerd/bin',
    [string]$BindAddress = '192.168.50.9',
    [int]$Port = 3090,
    [string]$Tag,
    [string]$Rollback,
    [int]$KeepImages = 3,
    [switch]$SkipVerify,
    # Read-only: prints the live logs and changes nothing.
    [switch]$Logs,
    [int]$Tail = 200
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$imageName = 'multiplayer-choicer-voicer'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workDir = Join-Path $env:TEMP 'multiplayer-choicer-voicer\deploy'
$remoteTarget = "$SshUser@$NahidaHost"

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string[]]$Arguments,
        [string]$FailureMessage
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        $detail = if ($FailureMessage) { $FailureMessage } else { "$Command exited with code $LASTEXITCODE." }
        throw $detail
    }
}

function Invoke-Remote {
    param(
        [Parameter(Mandatory)][string]$Script,
        [switch]$AllowFailure
    )
    # Base64 keeps the script free of characters that PowerShell or the remote shell would change.
    $payload = "export PATH=`$PATH:$RemoteDockerBin`nset -e`n" + $Script + "`n"
    $payload = $payload -replace "`r", ''
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    & ssh -p $SshPort -o BatchMode=yes $remoteTarget ('echo ' + $encoded + ' | base64 -d | sh')
    $exitCode = $LASTEXITCODE
    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "Remote command failed with exit code $exitCode."
    }
    return $exitCode
}

function Get-ReleaseTag {
    $version = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmm')
    $revision = 'nogit'
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $gitOutput = (& git -C $repoRoot rev-parse --short HEAD 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $gitOutput) {
            $revision = $gitOutput
            & git -C $repoRoot diff --quiet HEAD 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { $revision = "$revision-dirty" }
        }
    } catch {
        $revision = 'nogit'
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return "$version-$stamp-$revision"
}

Write-Step "Checking SSH access to $remoteTarget on port $SshPort"
Invoke-Remote -Script "echo connected as `$(id -un); docker version --format 'docker {{.Server.Version}}'" | Out-Null

if ($Logs) {
    Write-Step "Reading the last $Tail log lines"
    $script = "export PATH=`$PATH:$RemoteDockerBin`ncd $RemoteRoot`ndocker compose logs --no-color --timestamps --tail $Tail app`n"
    $script = $script -replace "`r", ''
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
    & ssh -p $SshPort -o BatchMode=yes $remoteTarget ('echo ' + $encoded + ' | base64 -d | sh')
    if ($LASTEXITCODE -ne 0) { throw "Reading logs failed with exit code $LASTEXITCODE." }
    return
}

if ($Rollback) {
    Write-Step "Rolling back to ${imageName}:$Rollback"
    $imageTag = $Rollback
    $rollbackCheck = @"
if ! docker image inspect ${imageName}:$Rollback >/dev/null 2>&1; then
  echo "Image ${imageName}:$Rollback is not on the host." >&2
  echo 'Available tags:' >&2
  docker images $imageName --format '  {{.Tag}}' >&2
  exit 1
fi
"@
    Invoke-Remote -Script $rollbackCheck | Out-Null
} else {
    if (-not $Tag) { $Tag = Get-ReleaseTag }
    $imageTag = $Tag

    if (-not $SkipVerify) {
        Write-Step 'Running the local type check and tests'
        Push-Location $repoRoot
        try {
            Invoke-Native -Command 'npm' -Arguments @('run', 'typecheck') -FailureMessage 'The type check failed.'
            Invoke-Native -Command 'npm' -Arguments @('test') -FailureMessage 'The tests failed.'
        } finally {
            Pop-Location
        }
    }

    Write-Step "Building ${imageName}:$imageTag"
    Invoke-Native -Command 'docker' -Arguments @('build', '--tag', "${imageName}:$imageTag", $repoRoot)

    $alreadyPresent = Invoke-Remote -AllowFailure -Script "docker image inspect ${imageName}:$imageTag >/dev/null 2>&1"
    if ($alreadyPresent -eq 0) {
        Write-Step "Image ${imageName}:$imageTag is already on Nahida; skipping the transfer"
    } else {
        New-Item -ItemType Directory -Force -Path $workDir | Out-Null
        $tarPath = Join-Path $workDir "$imageName-$imageTag.tar"
        $gzPath = "$tarPath.gz"
        Remove-Item -Path $tarPath, $gzPath -Force -ErrorAction SilentlyContinue

        Write-Step 'Exporting the image'
        Invoke-Native -Command 'docker' -Arguments @('save', '--output', $tarPath, "${imageName}:$imageTag")

        Write-Step 'Compressing the image'
        $source = [System.IO.File]::OpenRead($tarPath)
        try {
            $destination = [System.IO.File]::Create($gzPath)
            try {
                $gzip = New-Object System.IO.Compression.GZipStream($destination, [System.IO.Compression.CompressionLevel]::Optimal)
                try { $source.CopyTo($gzip) } finally { $gzip.Dispose() }
            } finally {
                $destination.Dispose()
            }
        } finally {
            $source.Dispose()
        }
        $megabytes = [math]::Round((Get-Item $gzPath).Length / 1MB, 1)
        Write-Host "    compressed image is $megabytes MB"

        Invoke-Remote -Script "mkdir -p $RemoteRoot" | Out-Null
        Write-Step 'Transferring the image to Nahida'
        Invoke-Native -Command 'scp' -Arguments @('-P', "$SshPort", '-q', $gzPath, "${remoteTarget}:$RemoteRoot/image.tar.gz")

        Write-Step 'Loading the image on Nahida'
        Invoke-Remote -Script "gunzip -c $RemoteRoot/image.tar.gz | docker load`nrm -f $RemoteRoot/image.tar.gz" | Out-Null
        Remove-Item -Path $tarPath, $gzPath -Force -ErrorAction SilentlyContinue
    }
}

Write-Step 'Uploading the Compose definition'
Invoke-Remote -Script "mkdir -p $RemoteRoot" | Out-Null
Invoke-Native -Command 'scp' -Arguments @('-P', "$SshPort", '-q', (Join-Path $repoRoot 'deploy\compose.yaml'), "${remoteTarget}:$RemoteRoot/compose.yaml")

Write-Step 'Writing the environment file'
# Tuning values that are already in the remote .env file are kept.
$envScript = @"
ENV_FILE=$RemoteRoot/.env
umask 077
read_existing() {
  if [ -f "`$ENV_FILE" ]; then
    grep "^`$1=" "`$ENV_FILE" 2>/dev/null | head -n 1 | cut -d= -f2-
  fi
}
KEEP=''
for KEY in LOG_LEVEL PACK_CACHE_MAX_GB DOWNLOAD_MAX_MB UPLOAD_MAX_MB VIDEO_MAX_HEIGHT VIDEO_PRESET VIDEO_CRF FFMPEG_THREADS ROOM_IDLE_HOURS CATALOG_REFRESH_HOURS; do
  VALUE=`$(read_existing `$KEY)
  if [ -n "`$VALUE" ]; then KEEP="`$KEEP`$KEY=`$VALUE
"; fi
done
{
  echo "MCV_IMAGE=${imageName}:$imageTag"
  echo "MCV_BIND_ADDRESS=$BindAddress"
  echo "MCV_PORT=$Port"
  printf '%s' "`$KEEP"
} > "`$ENV_FILE"
chmod 600 "`$ENV_FILE"
echo "    environment file written for ${imageName}:$imageTag"
"@
Invoke-Remote -Script $envScript | Out-Null

Write-Step 'Starting the Compose project'
$upScript = @"
cd $RemoteRoot
docker compose --env-file .env -f compose.yaml up -d --wait --remove-orphans
docker compose -f compose.yaml ps --format '    {{.Service}} {{.Status}}'
"@
Invoke-Remote -Script $upScript | Out-Null

Write-Step 'Checking the health endpoint'
$healthScript = @"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  CODE=`$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${BindAddress}:${Port}/healthz || echo 000)
  if [ "`$CODE" = '200' ]; then
    echo "    healthz responded 200 on attempt `$attempt"
    exit 0
  fi
  sleep 3
done
echo "    healthz never returned 200 (last code `$CODE)" >&2
cd $RemoteRoot && docker compose logs --tail 60 app >&2 || true
exit 1
"@
Invoke-Remote -Script $healthScript | Out-Null

if (-not $Rollback -and $KeepImages -gt 0) {
    Write-Step "Removing old images beyond the newest $KeepImages"
    $pruneScript = @"
docker images $imageName --format '{{.CreatedAt}}|{{.Tag}}' \
  | sort -r \
  | tail -n +$($KeepImages + 1) \
  | cut -d'|' -f2 \
  | while read -r old; do
      [ -n "`$old" ] || continue
      docker rmi "${imageName}:`$old" >/dev/null 2>&1 && echo "    removed ${imageName}:`$old" || true
    done
"@
    Invoke-Remote -Script $pruneScript -AllowFailure | Out-Null
}

Write-Host ''
Write-Host "Released ${imageName}:$imageTag" -ForegroundColor Green
Write-Host "  public       https://choicervoicer.throndir.com"
Write-Host "  upstream     http://${BindAddress}:${Port}  (the Nginx Proxy Manager host comes from scripts/configure-npm.ps1)"
Write-Host "  remote root  $RemoteRoot"
Write-Host "  rollback     pwsh -File scripts/deploy-nahida.ps1 -Rollback <previous-tag>"
exit 0

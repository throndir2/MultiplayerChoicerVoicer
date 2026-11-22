function Get-NahidaSshOptions {
    return @(
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'HostKeyAlias=[192.168.50.9]:9222',
        '-o', 'ConnectTimeout=3',
        '-o', 'ConnectionAttempts=1'
    )
}

function Resolve-NahidaAddress {
    param(
        [string]$NahidaHost,
        [int]$SshPort = 9222,
        [string]$SshUser = 'throndir'
    )

    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($NahidaHost) {
        $address = $null
        if ([System.Net.IPAddress]::TryParse($NahidaHost, [ref]$address)) {
            if ($address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
                throw "The Nahida host must resolve to an IPv4 address: $NahidaHost"
            }
            $candidates.Add($address.ToString())
        } else {
            $records = @(Resolve-DnsName -Name $NahidaHost -Type A -DnsOnly -ErrorAction Stop)
            foreach ($record in $records) {
                if ($record.Type -eq 'A') { $candidates.Add($record.IPAddress) }
            }
            if ($candidates.Count -eq 0) { throw "No IPv4 address found for $NahidaHost." }
        }
    } else {
        try {
            $records = @(Resolve-DnsName -Name 'nahida' -Type A -DnsOnly -ErrorAction Stop)
            foreach ($record in $records) {
                if ($record.Type -eq 'A' -and $record.IPAddress -match '^192\.168\.50\.(\d{1,3})$' -and
                    [int]$Matches[1] -ge 1 -and [int]$Matches[1] -le 254) {
                    $candidates.Add($record.IPAddress)
                }
            }
        } catch {
            Write-Verbose "Nahida DNS lookup failed: $_"
        }
        $candidates.Add('192.168.50.114')
        $candidates.Add('192.168.50.9')
    }

    $sshOptions = @(Get-NahidaSshOptions)
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        Write-Verbose "Checking Nahida at $candidate"
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & ssh @sshOptions -p $SshPort "${SshUser}@$candidate" 'true' 2>&1 | Out-Null
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($exitCode -eq 0) { return $candidate }
    }
    throw 'No Nahida address passed the pinned SSH identity and access check. No changes were made.'
}

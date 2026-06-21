[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet("Run", "Setup", "Uninstall", "Update", "Reinstall", "RestartAll", "Startup")]
    [string]$Action,

    # Setup parameters
    [string]$RootFsTar,
    [string]$TimeZone = "America/New_York",
    [string]$DataRootPath = "C:\wslservarr",
    [string]$WebUiRepoUrl = "https://github.com/miahnelson/wslservarr.git",
    [string]$WebUiRepoBranch = "main",
    [string]$LocalSourcePath = "",   # Dev mode: sync local Windows source with tar stream instead of pulling from GitHub
    [switch]$DevMode,                # Shorthand: sets LocalSourcePath to the script's own directory
    [string]$RootFsDownloadUrl = "https://cloud-images.ubuntu.com/wsl/noble/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz",
    [switch]$AutoDownloadRootFs = $true,
    [switch]$ForceRecreate,

    # Common parameters
    [string]$DistroName = "wslservarr-wsl",
    [string]$InstallPath = "C:\WSL\wslservarr-wsl",
    [string]$LinuxUser = "wslservarr",
    [string]$DownloadDir = "$PSScriptRoot\.cache",
    [switch]$SkipSelfUpdate,

    # Uninstall parameters
    [switch]$RemoveDistro,
    [switch]$PurgeData
)

$ErrorActionPreference = "Stop"
$InstallSettingsPath = Join-Path $PSScriptRoot ".wslservarr-install.json"
$StartupTaskName = "WSLServarr Startup"

# Resolve dev source path
if ($DevMode -and -not $LocalSourcePath) {
    $LocalSourcePath = $PSScriptRoot
}
if ($LocalSourcePath) {
    $LocalSourcePath = (Resolve-Path $LocalSourcePath).Path.TrimEnd('\')
    Write-Host "[DEV] Using local source: $LocalSourcePath" -ForegroundColor Cyan
}

function Get-DefaultInstallPathForDataRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath,
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    $qualifiedRoot = Split-Path -Path ([System.IO.Path]::GetFullPath($RootPath)) -Qualifier
    if ([string]::IsNullOrWhiteSpace($qualifiedRoot)) {
        throw "Unable to determine drive for root path '$RootPath'."
    }

    return Join-Path (Join-Path $qualifiedRoot 'WSL') $Distro
}

function Get-SavedInstallSettings {
    if (-not (Test-Path -LiteralPath $InstallSettingsPath)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $InstallSettingsPath -Raw | ConvertFrom-Json
    } catch {
        Write-Warning "Ignoring invalid install settings file: $InstallSettingsPath"
        return $null
    }
}

function Get-GitHubRawFileUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoUrl,
        [Parameter(Mandatory = $true)]
        [string]$Branch,
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $trimmedRepoUrl = $RepoUrl.Trim()
    if ($trimmedRepoUrl -notmatch '^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$') {
        return $null
    }

    $owner = $matches[1]
    $repo = $matches[2]
    return "https://raw.githubusercontent.com/$owner/$repo/$Branch/$RelativePath"
}

function Invoke-SelfUpdateIfNeeded {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [Parameter(Mandatory = $true)]
        [string]$RepoUrl,
        [Parameter(Mandatory = $true)]
        [string]$Branch
    )

    if ($SkipSelfUpdate -or $DevMode -or $LocalSourcePath) {
        return $false
    }

    $rawUrl = Get-GitHubRawFileUrl -RepoUrl $RepoUrl -Branch $Branch -RelativePath 'wslservarr.ps1'
    if ([string]::IsNullOrWhiteSpace($rawUrl)) {
        return $false
    }

    try {
        $remoteContent = (Invoke-WebRequest -Uri $rawUrl -UseBasicParsing -TimeoutSec 20).Content
        if ([string]::IsNullOrWhiteSpace($remoteContent)) {
            return $false
        }

        $localContent = Get-Content -LiteralPath $ScriptPath -Raw
        $normalizedLocal = ($localContent -replace "`r`n", "`n").Trim()
        $normalizedRemote = ($remoteContent -replace "`r`n", "`n").Trim()

        if ($normalizedLocal -eq $normalizedRemote) {
            return $false
        }

        $backupPath = "$ScriptPath.bak"
        Copy-Item -LiteralPath $ScriptPath -Destination $backupPath -Force
        Set-Content -LiteralPath $ScriptPath -Value $remoteContent -Encoding UTF8

        Write-Host "[SelfUpdate] Updated wslservarr.ps1 from $RepoUrl ($Branch)." -ForegroundColor Green
        Write-Host "[SelfUpdate] Previous version backed up to: $backupPath" -ForegroundColor DarkGray
        Write-Host "[SelfUpdate] Re-run the command to continue with the updated script." -ForegroundColor Yellow
        return $true
    } catch {
        Write-Warning "Self-update check skipped: $($_.Exception.Message)"
        return $false
    }
}

function Save-InstallSettings {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath,
        [Parameter(Mandatory = $true)]
        [string]$ResolvedInstallPath,
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    $payload = [ordered]@{
        dataRootPath = $RootPath
        installPath  = $ResolvedInstallPath
        distroName   = $Distro
    }

    $payload | ConvertTo-Json | Set-Content -LiteralPath $InstallSettingsPath -Encoding UTF8
}

function Test-WslServarrStartupTaskRegistered {
    $task = Get-ScheduledTask -TaskName $StartupTaskName -ErrorAction SilentlyContinue
    return ($null -ne $task)
}

function Register-WslServarrStartupTask {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
        throw "Scheduled Tasks cmdlets are not available on this system."
    }

    $resolvedScriptPath = [System.IO.Path]::GetFullPath($ScriptPath)
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $actionArgs = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action Run -DistroName "{1}"' -f $resolvedScriptPath, $Distro

    $taskAction = New-ScheduledTaskAction -Execute $powershellExe -Argument $actionArgs
    $taskTrigger = New-ScheduledTaskTrigger -AtStartup
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $taskSettings.MultipleInstances = 'IgnoreNew'

    $existingTask = Get-ScheduledTask -TaskName $StartupTaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Unregister-ScheduledTask -TaskName $StartupTaskName -Confirm:$false | Out-Null
    }

    Register-ScheduledTask -TaskName $StartupTaskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Starts WSLServarr automatically when Windows boots.' | Out-Null
    Write-Host "[Startup] Registered Windows startup task '$StartupTaskName'." -ForegroundColor DarkGray
}

function Unregister-WslServarrStartupTask {
    $existingTask = Get-ScheduledTask -TaskName $StartupTaskName -ErrorAction SilentlyContinue
    if (-not $existingTask) {
        return
    }

    Unregister-ScheduledTask -TaskName $StartupTaskName -Confirm:$false | Out-Null
    Write-Host "[Startup] Removed Windows startup task '$StartupTaskName'." -ForegroundColor DarkGray
}

function Set-WslServarrStartupPreference {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Enabled,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    if ($Enabled) {
        Register-WslServarrStartupTask -ScriptPath $ScriptPath -Distro $Distro
    } else {
        Unregister-WslServarrStartupTask
        Write-Host "[Startup] Windows auto-start disabled." -ForegroundColor DarkGray
    }
}

function Read-WslServarrStartupPreference {
    param(
        [bool]$DefaultEnabled = $true
    )

    $defaultPrompt = if ($DefaultEnabled) { 'Y/n' } else { 'y/N' }
    $response = Read-Host "Start WSLServarr automatically with Windows? [$defaultPrompt]"
    if ([string]::IsNullOrWhiteSpace($response)) {
        return $DefaultEnabled
    }

    switch -Regex ($response.Trim()) {
        '^(y|yes)$' { return $true }
        '^(n|no)$'  { return $false }
        default {
            Write-Host "Please answer y or n." -ForegroundColor Yellow
            return Read-WslServarrStartupPreference -DefaultEnabled $DefaultEnabled
        }
    }
}

$savedInstallSettings = Get-SavedInstallSettings
if (-not $PSBoundParameters.ContainsKey('DataRootPath') -and $savedInstallSettings?.dataRootPath) {
    $DataRootPath = [string]$savedInstallSettings.dataRootPath
}
if (-not $PSBoundParameters.ContainsKey('InstallPath') -and $savedInstallSettings?.installPath -and [string]$savedInstallSettings.distroName -eq $DistroName) {
    $InstallPath = [string]$savedInstallSettings.installPath
}

if ($PSCommandPath) {
    $didSelfUpdate = Invoke-SelfUpdateIfNeeded -ScriptPath $PSCommandPath -RepoUrl $WebUiRepoUrl -Branch $WebUiRepoBranch
    if ($didSelfUpdate) {
        exit 0
    }
}

# ============================================================================
# Helper Functions
# ============================================================================

function Invoke-Wsl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,
        [Parameter(Mandatory = $true)]
        [string]$Script
    )

    $normalizedScript = $Script -replace "`r", ""
    $normalizedScript = "export HOME=/root`n$normalizedScript"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalizedScript))
    $cmd = "echo $encoded | base64 -d | bash"
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & wsl -d $Distro -u root -- bash -lc $cmd 2>&1
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($output) {
        $output | ForEach-Object { Write-Host $_ }
    }
    if ($LASTEXITCODE -ne 0) {
        $normalizedOutput = ($output | Out-String)
        if ($normalizedOutput -match 'Synchronizing state of docker\.service') {
            $global:LASTEXITCODE = 0
            return
        }
        $details = if ($output) { ($output | Out-String).Trim() } else { "(no output)" }
        throw "WSL command failed in distro '$Distro' with exit code $LASTEXITCODE`n$details"
    }
}

function Invoke-WslCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,
        [Parameter(Mandatory = $true)]
        [string]$Script
    )

    $normalizedScript = $Script -replace "`r", ""
    $normalizedScript = "export HOME=/root`n$normalizedScript"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalizedScript))
    $cmd = "echo $encoded | base64 -d | bash"
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & wsl -d $Distro -u root -- bash -lc $cmd 2>&1
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($LASTEXITCODE -ne 0) {
        $normalizedOutput = ($output | Out-String)
        if ($normalizedOutput -match 'Synchronizing state of docker\.service') {
            return (($output | Out-String).Trim())
        }
        $details = if ($output) { ($output | Out-String).Trim() } else { "(no output)" }
        throw "WSL command failed in distro '$Distro' with exit code $LASTEXITCODE`n$details"
    }
    return (($output | Out-String).Trim())
}

function Invoke-WslRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,
        [Parameter(Mandatory = $true)]
        [string]$Script
    )

    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
    & wsl -d $Distro -u root -- bash -lc "echo $encoded | base64 -d | bash"
}

function Sync-LocalUiToWsl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot
    )

    $uiSource = Join-Path $SourceRoot 'wslservarr-ui'
    if (-not (Test-Path $uiSource)) {
        throw "Local UI source folder not found: $uiSource"
    }

    $wslParent = "\\wsl$\$Distro\opt\wslservarr\src"
    $wslDestination = Join-Path $wslParent 'wslservarr-ui'

    Write-Host "  Syncing UI folder from local workspace: $uiSource" -ForegroundColor DarkGray
    & wsl -d $Distro -u root -- bash -lc "mkdir -p /opt/wslservarr/src && rm -rf /opt/wslservarr/src/wslservarr-ui"

    if (Test-Path $wslDestination) {
        Remove-Item -LiteralPath $wslDestination -Recurse -Force
    }

    Copy-Item -LiteralPath $uiSource -Destination $wslParent -Recurse -Force
}

function Test-RunningAsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WslIpv4Address {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    $ip = Invoke-WslCapture -Distro $Distro -Script @'
ip -o -4 addr show eth0 | awk '{print $4}' | cut -d/ -f1
'@
    $ip = $ip.Trim()
    if ([string]::IsNullOrWhiteSpace($ip)) {
        $fallback = Invoke-WslCapture -Distro $Distro -Script 'hostname -I'
        $ip = (($fallback -split "\s+") | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1)
    }
    return [string]$ip
}

function Get-WslServarrConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    $raw = Invoke-WslCapture -Distro $Distro -Script 'cat /mnt/config/wslservarr-ui/config.json'
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }

    return $raw | ConvertFrom-Json
}

function Sync-HostPortAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    if (-not (Test-RunningAsAdministrator)) {
        throw "LAN port forwarding requires Administrator privileges. Re-run PowerShell as Administrator and run .\\wslservarr.ps1 again."
    }

    $cfg = $null
    try {
        $cfg = Get-WslServarrConfig -Distro $Distro
    } catch {
        Write-Warning "Skipping LAN port forwarding setup because config could not be read: $($_.Exception.Message)"
        return
    }

    if (-not $cfg) {
        Write-Warning "Skipping LAN port forwarding setup because no config was found."
        return
    }

    $wslIp = Get-WslIpv4Address -Distro $Distro
    if ([string]::IsNullOrWhiteSpace($wslIp)) {
        Write-Warning "Skipping LAN port forwarding setup because the WSL IP address could not be determined."
        return
    }

    $portMap = @(
        @{ Name = 'WSLServarrUI'; Port = 5055 }
    )

    if ($cfg.sabnzbd -and $cfg.sabnzbd.enabled) { $portMap += @{ Name = 'SABnzbd'; Port = [int]$cfg.sabnzbd.port } }
    if ($cfg.prowlarr -and $cfg.prowlarr.enabled) { $portMap += @{ Name = 'Prowlarr'; Port = [int]$cfg.prowlarr.port } }
    if ($cfg.sonarr -and $cfg.sonarr.enabled) { $portMap += @{ Name = 'Sonarr'; Port = [int]$cfg.sonarr.port } }
    if ($cfg.radarr -and $cfg.radarr.enabled) { $portMap += @{ Name = 'Radarr'; Port = [int]$cfg.radarr.port } }
    if ($cfg.jellyfin -and $cfg.jellyfin.enabled) { $portMap += @{ Name = 'Jellyfin'; Port = [int]$cfg.jellyfin.port } }

    foreach ($entry in $portMap) {
        $port = [int]$entry.Port
        if ($port -le 0) { continue }

        $ruleName = "WSLServarr $($entry.Name) TCP $port"
        $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if (-not $existingRule) {
            try {
                New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any | Out-Null
            } catch {
                Write-Warning "Could not create firewall rule for port ${port}: $($_.Exception.Message)"
            }
        }

        try {
            & netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$port | Out-Null
        } catch {
            # Ignore missing rules
        }

        try {
            & netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$port connectaddress=$wslIp connectport=$port | Out-Null
            Write-Host "[LAN] Forwarding 0.0.0.0:${port} -> ${wslIp}:${port}" -ForegroundColor DarkGray
        } catch {
            Write-Warning "Could not create port proxy for port ${port}: $($_.Exception.Message)"
        }
    }
}

function Start-RunMode {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro
    )

    $existing = wsl -l -q
    if ($existing -notcontains $Distro) {
        throw "Distro '$Distro' not found. Run with -Action Setup first."
    }

    Write-Host "[Run] Ensuring Docker service is running..."
    & wsl -d $Distro -u root -- bash -lc 'systemctl start docker || systemctl restart docker || true'

    Write-Host "[Run] Ensuring UI container is running..."
    $runScript = @'
set -euo pipefail
if [ ! -f /opt/wslservarr/compose.yml ]; then
  echo "Missing /opt/wslservarr/compose.yml"
  exit 2
fi

cd /opt/wslservarr
docker compose up -d wslservarr_ui
'@
    Invoke-Wsl -Distro $Distro -Script $runScript

    Sync-HostPortAccess -Distro $Distro

    Write-Host "[Run] Starting keepalive session to prevent WSL from idling out..."
    $keepAliveArgs = ('-d {0} -u root -- bash -lc ''exec tail -f /dev/null''' -f $Distro)
    $keepAliveProcess = Start-Process -FilePath 'wsl.exe' -ArgumentList $keepAliveArgs -WindowStyle Hidden -PassThru

    Write-Host ""
    Write-Host "WSLServarr UI: http://localhost:5055" -ForegroundColor Green
    $activeConfigMount = & wsl -d $Distro -u root -- bash -lc "mount | grep ' on /mnt/config ' | head -n1 | cut -d' ' -f1"
    if (-not [string]::IsNullOrWhiteSpace($activeConfigMount)) {
        Write-Host "Active config root: $activeConfigMount" -ForegroundColor DarkGray
    }
    Write-Host "Script will keep running to keep services warm. Press Ctrl+C to stop." -ForegroundColor Yellow
    Write-Host ""

    try {
        while ($true) {
            if ($keepAliveProcess.HasExited) {
                Write-Host "[Run] Keepalive session exited, restarting..." -ForegroundColor Yellow
                $keepAliveProcess = Start-Process -FilePath 'wsl.exe' -ArgumentList $keepAliveArgs -WindowStyle Hidden -PassThru
            }

            $status = & wsl -d $Distro -- bash -lc "docker ps --format '{{.Names}}\t{{.Status}}' | grep '^wslservarr_ui' || true"
            $ts = Get-Date -Format "HH:mm:ss"
            if ([string]::IsNullOrWhiteSpace($status)) {
                Write-Host "[$ts] wslservarr_ui not running | http://localhost:5055" -ForegroundColor Yellow
            } else {
                Write-Host "[$ts] $status | http://localhost:5055" -ForegroundColor DarkGray
            }

            if ((Get-Date) - $script:lastLanPortSync -gt [TimeSpan]::FromMinutes(10)) {
                try {
                    Sync-HostPortAccess -Distro $Distro
                    $script:lastLanPortSync = Get-Date
                } catch {
                    Write-Warning "LAN port sync failed: $($_.Exception.Message)"
                }
            }
            Start-Sleep -Seconds 30
        }
    } finally {
        if ($keepAliveProcess -and -not $keepAliveProcess.HasExited) {
            Stop-Process -Id $keepAliveProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

function Restart-AllServices {
        param(
                [Parameter(Mandatory = $true)]
                [string]$Distro
        )

        $existing = wsl -l -q
        if ($existing -notcontains $Distro) {
                throw "Distro '$Distro' not found. Run with -Action Setup first."
        }

        Write-Host "[RestartAll] Ensuring Docker service is running..."
        & wsl -d $Distro -u root -- bash -lc 'systemctl start docker || systemctl restart docker || true'

        Write-Host "[RestartAll] Restarting UI and app services..."
        $restartScript = @'
set -euo pipefail
        export COMPOSE_IGNORE_ORPHANS=1

if [ -f /opt/wslservarr/compose.yml ]; then
    docker compose -f /opt/wslservarr/compose.yml up -d wslservarr_ui
fi

if [ -f /opt/wslservarr/compose.apps.yml ]; then
    services=$(docker compose -f /opt/wslservarr/compose.apps.yml config --services || true)
    if [ -n "$services" ]; then
        docker compose -f /opt/wslservarr/compose.apps.yml up -d $services
    fi
fi

docker ps --format 'table {{.Names}}\t{{.Status}}'
'@
        Invoke-Wsl -Distro $Distro -Script $restartScript

        Sync-HostPortAccess -Distro $Distro

        Write-Host ""
        Write-Host "Restart complete." -ForegroundColor Green
        Write-Host "WSLServarr UI: http://localhost:5055" -ForegroundColor Green
}

# ============================================================================
# Action Selection
# ============================================================================

if ([string]::IsNullOrWhiteSpace($Action)) {
    Write-Host ""
    Write-Host "=== WSLServarr Manager ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "What would you like to do?"
    Write-Host "  1) Run app   - Start/keep UI running (default in 5s)"
    Write-Host "  2) Setup     - Install WSLServarr from scratch"
    Write-Host "  3) Update    - Redeploy UI to existing installation"
    Write-Host "  4) RestartAll - Restart all stack services"
    Write-Host "  5) Uninstall - Remove WSLServarr"
    Write-Host "  6) Reinstall - Recreate distro and reinstall stack"
    Write-Host "  7) Startup   - Enable/disable start with Windows"
    Write-Host ""

    $choice = $null
    Write-Host "Defaulting to 'Run app' in 5 seconds... Press 1-7 to choose another option." -ForegroundColor Yellow
    try {
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $deadline) {
            if ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.KeyChar -match '^[1-7]$') {
                    $choice = [string]$key.KeyChar
                    break
                }
            }
            Start-Sleep -Milliseconds 100
        }
    } catch {
        # Non-interactive terminal fallback
    }

    if ([string]::IsNullOrWhiteSpace($choice)) {
        $choice = "1"
    }

    switch ($choice) {
        "1" { $Action = "Run" }
        "2" { $Action = "Setup" }
        "3" { $Action = "Update" }
        "4" { $Action = "RestartAll" }
        "5" { $Action = "Uninstall" }
        "6" { $Action = "Reinstall" }
        "7" { $Action = "Startup" }
        default {
            Write-Host "Invalid choice. Exiting." -ForegroundColor Red
            exit 1
        }
    }
    Write-Host ""
}

$script:lastLanPortSync = Get-Date

$actionsRequiringAdmin = @('Run', 'Setup', 'Update', 'RestartAll', 'Startup')
if ($actionsRequiringAdmin -contains $Action -and -not (Test-RunningAsAdministrator)) {
    throw "Action '$Action' requires Administrator privileges for startup task or LAN configuration changes. Re-run PowerShell as Administrator and run .\\wslservarr.ps1 again."
}

if ($Action -eq "Reinstall") {
    Write-Host "Reinstall selected: forcing distro recreation and fresh setup..." -ForegroundColor Yellow
    $ForceRecreate = $true
    $Action = "Setup"
}

if ($Action -eq "Run") {
    Start-RunMode -Distro $DistroName
    exit 0
}

if ($Action -eq "RestartAll") {
    Restart-AllServices -Distro $DistroName
    exit 0
}

if ($Action -eq "Startup") {
    $startupRegistered = Test-WslServarrStartupTaskRegistered
    Write-Host ""
    Write-Host "=== WSLServarr Startup Preference ===" -ForegroundColor Cyan
    Write-Host "Current setting: $(if ($startupRegistered) { 'Enabled' } else { 'Disabled' })"
    Write-Host ""

    $enableStartup = Read-WslServarrStartupPreference -DefaultEnabled $startupRegistered
    Set-WslServarrStartupPreference -Enabled $enableStartup -ScriptPath $PSCommandPath -Distro $DistroName

    Write-Host "Startup preference updated." -ForegroundColor Green
    exit 0
}

# ============================================================================
# SETUP ACTION
# ============================================================================

if ($Action -eq "Setup") {
    Write-Host "[1/8] Checking prerequisites..."
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
        throw "WSL is not available. Install WSL first (wsl --install), reboot, then retry."
    }

    # Interactive Windows root folder selection
    Write-Host ""
    Write-Host "=== WSLServarr Setup ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Choose a single Windows root folder."
    Write-Host "The script will create and use these subfolders under it:"
    Write-Host "  - config"
    Write-Host "  - media"
    Write-Host "  - downloads"
    Write-Host ""

    $selectedRoot = Read-Host "Root folder [$DataRootPath]"
    if ([string]::IsNullOrWhiteSpace($selectedRoot)) {
        $selectedRoot = $DataRootPath
    }

    $dataRootPath = [System.IO.Path]::GetFullPath($selectedRoot)
    if ($PSBoundParameters.ContainsKey('InstallPath')) {
        $resolvedInstallPath = [System.IO.Path]::GetFullPath($InstallPath)
    } else {
        $resolvedInstallPath = Get-DefaultInstallPathForDataRoot -RootPath $dataRootPath -Distro $DistroName
    }
    $InstallPath = $resolvedInstallPath
    $configPath = Join-Path $dataRootPath "config"
    $mediaPath = Join-Path $dataRootPath "media"
    $downloadsPath = Join-Path $dataRootPath "downloads"
    
    # Create Windows folders if they don't exist
    Write-Host ""
    Write-Host "Creating root + subfolders..."
    New-Item -ItemType Directory -Path $dataRootPath -Force | Out-Null
    New-Item -ItemType Directory -Path $configPath -Force | Out-Null
    New-Item -ItemType Directory -Path $mediaPath -Force | Out-Null
    New-Item -ItemType Directory -Path $downloadsPath -Force | Out-Null
    
    Write-Host ""
    Write-Host "✓ Folder Setup:" -ForegroundColor Green
    Write-Host "  Root:      $dataRootPath"
    Write-Host "  Config:    $configPath"
    Write-Host "  Media:     $mediaPath"
    Write-Host "  Downloads: $downloadsPath"
    Write-Host "  WSL VHDX:  $InstallPath"
    Write-Host ""
    Write-Host "These will be mounted as:"
    Write-Host "  /mnt/config    (in WSL)"
    Write-Host "  /mnt/media     (in WSL)"
    Write-Host "  /mnt/downloads (in WSL)"
    Write-Host ""

    $startupDefaultEnabled = Test-WslServarrStartupTaskRegistered
    $enableStartupWithWindows = Read-WslServarrStartupPreference -DefaultEnabled $startupDefaultEnabled

    Save-InstallSettings -RootPath $dataRootPath -ResolvedInstallPath $InstallPath -Distro $DistroName
    Set-WslServarrStartupPreference -Enabled $enableStartupWithWindows -ScriptPath $PSCommandPath -Distro $DistroName

    if ([string]::IsNullOrWhiteSpace($RootFsTar)) {
        $installedDistros = @(wsl -l -q)
        if ($installedDistros -contains 'Ubuntu') {
            Write-Host "[1/7] RootFS not provided. Exporting existing 'Ubuntu' distro rootfs..."
            New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null
            $RootFsTar = Join-Path $DownloadDir "ubuntu-rootfs.tar"
            if (-not (Test-Path -LiteralPath $RootFsTar)) {
                & wsl --export Ubuntu $RootFsTar
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to export existing Ubuntu distro."
                }
            }
        }

        if ([string]::IsNullOrWhiteSpace($RootFsTar) -and -not $AutoDownloadRootFs) {
            throw "RootFsTar is required when -AutoDownloadRootFs is disabled."
        }

        if ([string]::IsNullOrWhiteSpace($RootFsTar)) {
            Write-Host "[1/7] RootFS not provided. Downloading Ubuntu rootfs..."
            if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
                throw "'tar' command is required to unpack .tar.gz rootfs archives."
            }

            New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null
            $archivePath = Join-Path $DownloadDir (Split-Path $RootFsDownloadUrl -Leaf)

            if (-not (Test-Path -LiteralPath $archivePath)) {
                Invoke-WebRequest -Uri $RootFsDownloadUrl -OutFile $archivePath
            }

            if ($archivePath -like "*.tar.gz") {
                $extractedTar = Join-Path $DownloadDir ([IO.Path]::GetFileNameWithoutExtension($archivePath))
                if (-not (Test-Path -LiteralPath $extractedTar)) {
                    & tar -xzf $archivePath -C $DownloadDir
                }
                $RootFsTar = $extractedTar
            } else {
                $RootFsTar = $archivePath
            }
        }
    }

    if (-not (Test-Path -LiteralPath $RootFsTar)) {
        throw "RootFS tar not found after resolution: $RootFsTar"
    }

    $distroExists = $false
    $existing = wsl -l -q
    if ($existing -contains $DistroName) {
        $distroExists = $true
    }

    if ($distroExists -and -not $ForceRecreate) {
        throw "Distro '$DistroName' already exists. Re-run with -ForceRecreate to replace it."
    }

    if ($distroExists -and $ForceRecreate) {
        Write-Host "[2/7] Unregistering existing distro '$DistroName'..."
        & wsl --unregister $DistroName
    } else {
        Write-Host "[2/7] Preparing new installation..."
    }

    if (Test-Path -LiteralPath $InstallPath) {
        Write-Host "[2/7] Removing stale install path '$InstallPath'..." -ForegroundColor DarkGray
        Remove-Item -LiteralPath $InstallPath -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Host "[3/7] Importing dedicated distro '$DistroName'..."
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
    & wsl --import $DistroName $InstallPath $RootFsTar --version 2
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to import distro '$DistroName' into '$InstallPath'."
    }

    Write-Host "[4/7] Bootstrapping base Linux user + systemd..."
    $bootstrapSystemd = @'
set -euo pipefail

if ! id -u wslservarr >/dev/null 2>&1; then
    useradd -m -s /bin/bash wslservarr
fi

mkdir -p /etc/sudoers.d
cat >/etc/sudoers.d/90-wslservarr <<'EOF'
wslservarr ALL=(ALL) NOPASSWD:ALL
EOF
chmod 0440 /etc/sudoers.d/90-wslservarr

cat >/etc/wsl.conf <<'EOF'
[boot]
systemd=true

[user]
default=wslservarr

[interop]
appendWindowsPath=false

[automount]
enabled=false
EOF

cat >/etc/profile.d/00-wslservarr-homefix.sh <<'EOF'
if [ -n "$USER" ] && [ -d "/home/$USER" ]; then
  case "$HOME" in
    [A-Za-z]:*|[A-Za-z]:\\*) export HOME="/home/$USER" ;;
  esac
fi
EOF
chmod 0644 /etc/profile.d/00-wslservarr-homefix.sh
'@
    Invoke-Wsl -Distro $DistroName -Script $bootstrapSystemd

    Write-Host "[5/8] Restarting distro to apply systemd..."
    & wsl --terminate $DistroName
    Start-Sleep -Seconds 2

    Write-Host "[6/8] Preparing web UI source sync from GitHub..."
    & wsl -d $DistroName -u root -- bash -lc "mkdir -p /opt/wslservarr/src"

    Write-Host "[7/8] Mounting Windows folders into WSL..."
    
    # Convert Windows paths to fstab format (preserve exact case for drvfs)
    # drvfs requires paths in format: C:\path\to\folder or C:/path/to/folder
    $configPathFstab = $configPath -replace '/', '\'
    $mediaPathFstab = $mediaPath -replace '/', '\'
    $downloadsPathFstab = $downloadsPath -replace '/', '\'
    
    # Create mount directories and add them to fstab
    $fstabEntry = "$configPathFstab`t/mnt/config`tdrvfs`tcase=off,metadata,uid=1000,gid=1000`t0`t0`n$mediaPathFstab`t/mnt/media`tdrvfs`tcase=off,metadata,uid=1000,gid=1000`t0`t0`n$downloadsPathFstab`t/mnt/downloads`tdrvfs`tcase=off,metadata,uid=1000,gid=1000`t0`t0"
    
    Write-Host "  Mounting:"
    Write-Host "    $configPathFstab → /mnt/config"
    Write-Host "    $mediaPathFstab → /mnt/media"
    Write-Host "    $downloadsPathFstab → /mnt/downloads"
    Write-Host ""
    
    $mountScript = @"
set -euo pipefail
mkdir -p /mnt/config /mnt/media /mnt/downloads

# Remove old entries if they exist
sed -i '/\/mnt\/config\|\/mnt\/media\|\/mnt\/downloads/d' /etc/fstab

# Add new fstab entries
cat >>/etc/fstab <<'FSTABEOF'
$fstabEntry
FSTABEOF

# Mount all filesystems
mount -a

# Verify mounts
echo "Mount verification:"
mount | grep -E '/mnt/(config|media|downloads)' || echo "  (mounts may appear on next WSL restart)"
"@
    Invoke-Wsl -Distro $DistroName -Script $mountScript

    Write-Host "[8/8] Installing Docker Engine + Compose + minimal WSLServarr UI..."

    $setupUsesLocalUi = if ($LocalSourcePath) { "1" } else { "0" }

    $installStack = @"
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

setupUsesLocalUi="$setupUsesLocalUi"

apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release libsecret-1-0 gnome-keyring git

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release
ARCH=`$(dpkg --print-architecture)
echo "deb [arch=`$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu `$VERSION_CODENAME stable" >/etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl start docker || systemctl restart docker || true

usermod -aG docker $LinuxUser

rm -rf /root/.docker /home/$LinuxUser/.docker
mkdir -p /root/.docker /home/$LinuxUser/.docker
printf '%s\n' '{"auths":{}}' >/root/.docker/config.json
printf '%s\n' '{"auths":{}}' >/home/${LinuxUser}/.docker/config.json
chown -R ${LinuxUser}:${LinuxUser} /home/${LinuxUser}/.docker

mkdir -p /opt/wslservarr
mkdir -p /mnt/config/wslservarr-ui

if [ "$setupUsesLocalUi" = "1" ]; then
    rm -rf /opt/wslservarr/src
    mkdir -p /opt/wslservarr/src
else
    git config --global --add safe.directory /opt/wslservarr/src || true
    if [ -d /opt/wslservarr/src/.git ]; then
        git -C /opt/wslservarr/src fetch --depth 1 origin $WebUiRepoBranch
        git -C /opt/wslservarr/src checkout -B $WebUiRepoBranch origin/$WebUiRepoBranch
        git -C /opt/wslservarr/src reset --hard origin/$WebUiRepoBranch
    else
        rm -rf /opt/wslservarr/src
        git clone --depth 1 --branch $WebUiRepoBranch $WebUiRepoUrl /opt/wslservarr/src
    fi
fi

chown -R ${LinuxUser}:${LinuxUser} /opt/wslservarr /mnt/config /mnt/media /mnt/downloads

cat >/opt/wslservarr/compose.yml <<'COMPOSEOF'
services:
    wslservarr_ui:
        build: ./src/wslservarr-ui
        container_name: wslservarr_ui
        environment:
            - PORT=5055
            - CONFIG_PATH=/data/config.json
            - TZ=$TimeZone
        volumes:
            - /var/run/docker.sock:/var/run/docker.sock
            - /mnt/config/wslservarr-ui:/data
            - /opt/wslservarr:/opt/wslservarr
            - /mnt/config:/mnt/config
            - /mnt/media:/mnt/media
            - /mnt/downloads:/mnt/downloads
        ports:
            - "5055:5055"
        restart: unless-stopped
COMPOSEOF

cd /opt/wslservarr
docker compose pull
if [ "$setupUsesLocalUi" = "1" ]; then
    echo "Deferring UI build until local dev sources are synced"
else
    docker compose up -d --build
fi

# Ensure distro stays running
systemctl set-default multi-user.target
"@
    Invoke-Wsl -Distro $DistroName -Script $installStack
    if ($LocalSourcePath) {
        Write-Host "[DEV] Syncing local UI source..."
        Sync-LocalUiToWsl -Distro $DistroName -SourceRoot $LocalSourcePath
        & wsl -d $DistroName -u root -- bash -lc "cd /opt/wslservarr && docker compose up -d --build wslservarr_ui"
    }

    Write-Host "Completed." -ForegroundColor Green
    Write-Host ""
    Write-Host "Apps:"
    Write-Host "  WSLServarrUI http://localhost:5055"
    Write-Host ""
    
    # Keep the distro running by ensuring docker and systemd are active
    Write-Host "Starting distro services..."
    & wsl -d $DistroName -u root -- systemctl start docker

    # Normalize Docker client config JSON files (handles older malformed installs)
    $dockerConfigRepair = @(
        'set -euo pipefail',
        'mkdir -p /root/.docker /home/wslservarr/.docker',
        'printf ''%s\n'' ''{"auths":{}}'' >/root/.docker/config.json',
        'printf ''%s\n'' ''{"auths":{}}'' >/home/wslservarr/.docker/config.json',
        'chown -R wslservarr:wslservarr /home/wslservarr/.docker'
    ) -join "`n"
    Invoke-WslRoot -Distro $DistroName -Script $dockerConfigRepair

    Start-Sleep -Seconds 2
    
    # Verify containers are running
    $containerCheck = wsl -d $DistroName -- bash -lc "docker ps --format 'table {{.Names}}\t{{.Status}}'" 2>&1
    Write-Host "Container Status:"
    Write-Host $containerCheck

    Sync-HostPortAccess -Distro $DistroName
    Write-Host ""
    Write-Host "Windows Folders:"
    Write-Host "  Root:      $dataRootPath"
    Write-Host "  Config:    $configPath"
    Write-Host "  Media:     $mediaPath"
    Write-Host "  Downloads: $downloadsPath"
    Write-Host "  WSL VHDX:  $InstallPath"
    Write-Host ""
    Write-Host "Open shell: wsl -d $DistroName"
    Write-Host "Stack file: /opt/wslservarr/compose.yml"
    Write-Host ""
    Write-Host "Tip: Install Sonarr/Radarr/SABnzbd from the web UI first-run setup page."

    Start-RunMode -Distro $DistroName
}

# ============================================================================
# UPDATE ACTION
# ============================================================================

elseif ($Action -eq "Update") {
    $existing = wsl -l -q
    if ($existing -notcontains $DistroName) {
        throw "Distro '$DistroName' not found. Run with -Action Setup first."
    }

    if ($LocalSourcePath) {
        Write-Host "[1/4] Syncing UI sources from local path (dev mode): $LocalSourcePath"
        Sync-LocalUiToWsl -Distro $DistroName -SourceRoot $LocalSourcePath
        Write-Host "  Sync complete."
    } else {
        Write-Host "[1/4] Syncing UI sources from GitHub..."
        $syncUiScript = @"
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
if ! command -v git >/dev/null 2>&1; then
    apt-get update
    apt-get install -y git
fi

mkdir -p /opt/wslservarr/src
git config --global --add safe.directory /opt/wslservarr/src || true
if [ -d /opt/wslservarr/src/.git ]; then
    git -C /opt/wslservarr/src fetch --depth 1 origin $WebUiRepoBranch
    git -C /opt/wslservarr/src checkout -B $WebUiRepoBranch origin/$WebUiRepoBranch
    git -C /opt/wslservarr/src reset --hard origin/$WebUiRepoBranch
else
    rm -rf /opt/wslservarr/src
    git clone --depth 1 --branch $WebUiRepoBranch $WebUiRepoUrl /opt/wslservarr/src
fi
"@
        Invoke-Wsl -Distro $DistroName -Script $syncUiScript
    }

    Write-Host "[2/4] Ensuring compose service exists..."
        $ensureComposeScript = @'
set -euo pipefail
mkdir -p /mnt/config/wslservarr-ui
if ! grep -q "wslservarr_ui:" /opt/wslservarr/compose.yml; then
cat >>/opt/wslservarr/compose.yml <<'BASHEOF'

    wslservarr_ui:
        build: ./src/wslservarr-ui
        container_name: wslservarr_ui
        environment:
            - PORT=5055
            - CONFIG_PATH=/data/config.json
        volumes:
            - /var/run/docker.sock:/var/run/docker.sock
            - /mnt/config/wslservarr-ui:/data
            - /opt/wslservarr:/opt/wslservarr
            - /mnt/config:/mnt/config
            - /mnt/media:/mnt/media
            - /mnt/downloads:/mnt/downloads
        ports:
            - "5055:5055"
        restart: unless-stopped
BASHEOF
fi
'@
        Invoke-Wsl -Distro $DistroName -Script $ensureComposeScript

    $dockerConfigRepair = @(
        'set -euo pipefail',
        'mkdir -p /root/.docker /home/wslservarr/.docker',
        'printf ''%s\n'' ''{"auths":{}}'' >/root/.docker/config.json',
        'printf ''%s\n'' ''{"auths":{}}'' >/home/wslservarr/.docker/config.json',
        'chown -R wslservarr:wslservarr /home/wslservarr/.docker'
    ) -join "`n"
    Invoke-WslRoot -Distro $DistroName -Script $dockerConfigRepair

    Write-Host "[3/4] Building and starting custom UI..."
    & wsl -d $DistroName -- bash -lc "cd /opt/wslservarr && docker compose up -d --build wslservarr_ui || true"

    Sync-HostPortAccess -Distro $DistroName

    Write-Host "[4/4] Done." -ForegroundColor Green
    Write-Host "UI updated: http://localhost:5055"
}

# ============================================================================
# UNINSTALL ACTION
# ============================================================================

elseif ($Action -eq "Uninstall") {
    try {
        Unregister-WslServarrStartupTask
    } catch {
        Write-Warning "Could not remove Windows startup task '$StartupTaskName': $($_.Exception.Message)"
    }

    $existing = wsl -l -q
    if ($existing -notcontains $DistroName) {
        Write-Warning "Distro '$DistroName' was not found."
        if ($RemoveDistro -and (Test-Path -LiteralPath $InstallPath)) {
            if ($PSCmdlet.ShouldProcess($InstallPath, "Remove leftover install path")) {
                Remove-Item -LiteralPath $InstallPath -Recurse -Force
                Write-Host "Removed leftover install path: $InstallPath"
            }
        }
    } else {
        # Interactive prompts if no flags provided
        if (-not $PSBoundParameters.ContainsKey('RemoveDistro') -and -not $PSBoundParameters.ContainsKey('PurgeData')) {
            Write-Host ""
            Write-Host "=== WSLServarr Uninstall Options ===" -ForegroundColor Cyan
            Write-Host ""

            $response = Read-Host "Remove all containers (UI, Sonarr, Radarr, SABnzbd)? [Y/n]"
            if ($response -ne 'n' -and $response -ne 'N') {
                $removeContainers = $true
            } else {
                Write-Host "Skipping uninstall." -ForegroundColor Yellow
                exit 0
            }

            $response = Read-Host "Purge all data (/srv/config, /srv/downloads, /srv/media)? [y/N]"
            if ($response -eq 'y' -or $response -eq 'Y') {
                $PurgeData = $true
            }

            $response = Read-Host "Remove the WSL distro entirely (cannot be undone)? [y/N]"
            if ($response -eq 'y' -or $response -eq 'Y') {
                $RemoveDistro = $true
            }

            Write-Host ""
        }

        Write-Host "[1/4] Stopping and removing WSLServarr containers from '$DistroName'..."
    $orOp = $null; $orOp = [char]124 + [char]124  # || operator
        $cleanupScript = @(
            'set -euo pipefail',
            '',
            'if command -v docker >/dev/null 2>&1; then',
            '  if [ -f /opt/wslservarr/compose.yml ]; then',
            "    docker compose -f /opt/wslservarr/compose.yml down --remove-orphans $orOp true",
            '  fi',
            '',
            '  if [ -f /opt/wslservarr/compose.apps.yml ]; then',
            "    docker compose -f /opt/wslservarr/compose.apps.yml down --remove-orphans $orOp true",
            '  fi',
            '',
            "  docker rm -f wslservarr_ui sonarr radarr sabnzbd >/dev/null 2>&1 $orOp true",
            'fi'
        ) -join "`n"
        if ($PSCmdlet.ShouldProcess($DistroName, "Stop and remove WSLServarr containers")) {
            Invoke-WslRoot -Distro $DistroName -Script $cleanupScript
        }

        if ($PurgeData) {
            Write-Host "[2/4] Purging WSLServarr data directories in distro..."
            $purgeScript = @(
                'set -euo pipefail',
                'rm -rf /srv/config/wslservarr-ui /srv/config/sonarr /srv/config/radarr /srv/config/sabnzbd',
                'rm -rf /srv/downloads /srv/media',
                'rm -f /opt/wslservarr/compose.apps.yml'
            ) -join "`n"
            if ($PSCmdlet.ShouldProcess($DistroName, "Purge /srv and app compose data")) {
                Invoke-WslRoot -Distro $DistroName -Script $purgeScript
            }
        } else {
            Write-Host "[2/4] Keeping data (use -PurgeData to remove /srv config/media/downloads)."
        }

        Write-Host "[3/4] Terminating distro..."
        if ($PSCmdlet.ShouldProcess($DistroName, "Terminate distro")) {
            & wsl --terminate $DistroName
        }

        if ($RemoveDistro) {
            Write-Host "[4/4] Unregistering distro..."
            if ($PSCmdlet.ShouldProcess($DistroName, "Unregister distro")) {
                & wsl --unregister $DistroName
            }

            if (Test-Path -LiteralPath $InstallPath) {
                if ($PSCmdlet.ShouldProcess($InstallPath, "Remove install path")) {
                    Remove-Item -LiteralPath $InstallPath -Recurse -Force
                }
            }

            if ((Test-Path -LiteralPath $InstallSettingsPath) -and $PSCmdlet.ShouldProcess($InstallSettingsPath, "Remove saved install settings")) {
                Remove-Item -LiteralPath $InstallSettingsPath -Force
            }

            Write-Host "Removed distro '$DistroName'." -ForegroundColor Green
        } else {
            Write-Host "[4/4] Done." -ForegroundColor Green
            Write-Host "Distro kept. Re-run with -RemoveDistro to fully uninstall it."
        }
    }
}




[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$DistroName = "servarr-wsl",
    [string]$InstallPath = "C:\WSL\servarr-wsl",
    [switch]$RemoveDistro,
    [switch]$PurgeData
)

$ErrorActionPreference = "Stop"

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

if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    throw "WSL is not available on this system."
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
    return
}

Write-Host "[1/4] Stopping and removing Servarr containers from '$DistroName'..."
$cleanupScript = @"
set -euo pipefail

if command -v docker >/dev/null 2>&1; then
  if [ -f /opt/servarr/compose.yml ]; then
    docker compose -f /opt/servarr/compose.yml down --remove-orphans || true
  fi

  if [ -f /opt/servarr/compose.apps.yml ]; then
    docker compose -f /opt/servarr/compose.apps.yml down --remove-orphans || true
  fi

  docker rm -f servarr_ui sonarr radarr sabnzbd >/dev/null 2>&1 || true
fi
"@
if ($PSCmdlet.ShouldProcess($DistroName, "Stop and remove Servarr containers")) {
    Invoke-WslRoot -Distro $DistroName -Script $cleanupScript
}

if ($PurgeData) {
    Write-Host "[2/4] Purging Servarr data directories in distro..."
    $purgeScript = @"
set -euo pipefail
rm -rf /srv/config/servarr-ui /srv/config/sonarr /srv/config/radarr /srv/config/sabnzbd
rm -rf /srv/downloads /srv/media
rm -f /opt/servarr/compose.apps.yml
"@
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

    Write-Host "Removed distro '$DistroName'."
} else {
    Write-Host "Distro kept. Re-run with -RemoveDistro to fully uninstall it."
}

Write-Host "Done."

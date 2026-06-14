[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet("Setup", "Uninstall", "Update")]
    [string]$Action,

    # Setup parameters
    [string]$RootFsTar,
    [string]$TimeZone = "America/New_York",
    [string]$DataRootPath = "$env:USERPROFILE\ServarrData",
    [string]$RootFsDownloadUrl = "https://cloud-images.ubuntu.com/wsl/noble/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz",
    [switch]$AutoDownloadRootFs = $true,
    [switch]$ForceRecreate,

    # Common parameters
    [string]$DistroName = "servarr-wsl",
    [string]$InstallPath = "C:\WSL\servarr-wsl",
    [string]$LinuxUser = "servarr",
    [string]$DownloadDir = "$PSScriptRoot\.cache",

    # Uninstall parameters
    [switch]$RemoveDistro,
    [switch]$PurgeData
)

$ErrorActionPreference = "Stop"

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
    & wsl -d $Distro -u root -- bash -lc $cmd
    if ($LASTEXITCODE -ne 0) {
        throw "WSL command failed in distro '$Distro' with exit code $LASTEXITCODE"
    }
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

# ============================================================================
# Action Selection
# ============================================================================

if ([string]::IsNullOrWhiteSpace($Action)) {
    Write-Host ""
    Write-Host "=== Servarr WSL Manager ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "What would you like to do?"
    Write-Host "  1) Setup    - Install Servarr WSL from scratch"
    Write-Host "  2) Update   - Redeploy UI to existing installation"
    Write-Host "  3) Uninstall - Remove Servarr WSL"
    Write-Host ""
    $choice = Read-Host "Enter your choice (1-3)"

    switch ($choice) {
        "1" { $Action = "Setup" }
        "2" { $Action = "Update" }
        "3" { $Action = "Uninstall" }
        default {
            Write-Host "Invalid choice. Exiting." -ForegroundColor Red
            exit 1
        }
    }
    Write-Host ""
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
    Write-Host "=== Servarr WSL Setup ===" -ForegroundColor Cyan
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
    Write-Host ""
    Write-Host "These will be mounted as:"
    Write-Host "  /mnt/config    (in WSL)"
    Write-Host "  /mnt/media     (in WSL)"
    Write-Host "  /mnt/downloads (in WSL)"
    Write-Host ""

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

    $uiPath = Join-Path $PSScriptRoot "servarr-ui"
    if (-not (Test-Path -LiteralPath $uiPath)) {
        throw "Custom UI project not found: $uiPath"
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

    Write-Host "[3/7] Importing dedicated distro '$DistroName'..."
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
    & wsl --import $DistroName $InstallPath $RootFsTar --version 2

    Write-Host "[4/7] Bootstrapping base Linux user + systemd..."
    $bootstrapSystemd = @'
set -euo pipefail

if ! id -u servarr >/dev/null 2>&1; then
  useradd -m -s /bin/bash servarr
fi

mkdir -p /etc/sudoers.d
cat >/etc/sudoers.d/90-servarr <<'EOF'
servarr ALL=(ALL) NOPASSWD:ALL
EOF
chmod 0440 /etc/sudoers.d/90-servarr

cat >/etc/wsl.conf <<'EOF'
[boot]
systemd=true

[user]
default=servarr

[interop]
appendWindowsPath=false

[automount]
enabled=false
EOF

cat >/etc/profile.d/00-servarr-homefix.sh <<'EOF'
if [ -n "$USER" ] && [ -d "/home/$USER" ]; then
  case "$HOME" in
    [A-Za-z]:*|[A-Za-z]:\\*) export HOME="/home/$USER" ;;
  esac
fi
EOF
chmod 0644 /etc/profile.d/00-servarr-homefix.sh
'@
    Invoke-Wsl -Distro $DistroName -Script $bootstrapSystemd

    Write-Host "[5/8] Restarting distro to apply systemd..."
    & wsl --terminate $DistroName
    Start-Sleep -Seconds 2

    Write-Host "[6/8] Copying custom web UI sources into distro..."
    & wsl -d $DistroName -u root -- bash -lc "mkdir -p /opt/servarr"
    tar -C $PSScriptRoot -cf - servarr-ui | wsl -d $DistroName -u root -- bash -lc "tar -xf - -C /opt/servarr"

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

    Write-Host "[8/8] Installing Docker Engine + Compose + minimal Servarr UI..."
    $installStack = @"
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release libsecret-1-0 gnome-keyring

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release
ARCH=`$(dpkg --print-architecture)
echo "deb [arch=`$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu `$VERSION_CODENAME stable" >/etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

usermod -aG docker $LinuxUser

rm -rf /root/.docker /home/$LinuxUser/.docker
mkdir -p /root/.docker /home/$LinuxUser/.docker
printf '%s\n' '{\"auths\":{}}' >/root/.docker/config.json
printf '%s\n' '{\"auths\":{}}' >/home/`$LinuxUser/.docker/config.json
chown -R `$LinuxUser:`$LinuxUser /home/`$LinuxUser/.docker

mkdir -p /opt/servarr
mkdir -p /mnt/config/servarr-ui
chown -R `$LinuxUser:`$LinuxUser /opt/servarr /mnt/config /mnt/media /mnt/downloads

cat >/opt/servarr/compose.yml <<'COMPOSEOF'
services:
  servarr_ui:
    build: ./servarr-ui
    container_name: servarr_ui
    environment:
      - PORT=5055
      - CONFIG_PATH=/data/config.json
      - TZ=$TimeZone
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/config/servarr-ui:/data
      - /opt/servarr:/opt/servarr
    ports:
      - "5055:5055"
    restart: unless-stopped
COMPOSEOF

cd /opt/servarr
docker compose pull
docker compose up -d --build

# Ensure distro stays running
systemctl set-default multi-user.target
"@
    Invoke-Wsl -Distro $DistroName -Script $installStack

    Write-Host "Completed." -ForegroundColor Green
    Write-Host ""
    Write-Host "Apps:"
    Write-Host "  ServarrUI http://localhost:5055"
    Write-Host ""
    
    # Keep the distro running by ensuring docker and systemd are active
    Write-Host "Starting distro services..."
    & wsl -d $DistroName -u root -- systemctl start docker
    Start-Sleep -Seconds 2
    
    # Verify containers are running
    $containerCheck = wsl -d $DistroName -- bash -lc "docker ps --format 'table {{.Names}}\t{{.Status}}'" 2>&1
    Write-Host "Container Status:"
    Write-Host $containerCheck
    Write-Host ""
    Write-Host "Windows Folders:"
    Write-Host "  Root:      $dataRootPath"
    Write-Host "  Config:    $configPath"
    Write-Host "  Media:     $mediaPath"
    Write-Host "  Downloads: $downloadsPath"
    Write-Host ""
    Write-Host "Open shell: wsl -d $DistroName"
    Write-Host "Stack file: /opt/servarr/compose.yml"
    Write-Host ""
    Write-Host "Tip: Install Sonarr/Radarr/SABnzbd from the web UI first-run setup page."
}

# ============================================================================
# UPDATE ACTION
# ============================================================================

elseif ($Action -eq "Update") {
    $uiPath = Join-Path $PSScriptRoot "servarr-ui"
    if (-not (Test-Path -LiteralPath $uiPath)) {
        throw "Custom UI project not found: $uiPath"
    }

    $existing = wsl -l -q
    if ($existing -notcontains $DistroName) {
        throw "Distro '$DistroName' not found. Run with -Action Setup first."
    }

    Write-Host "[1/4] Copying UI sources..."
    & wsl -d $DistroName -u root -- bash -lc "mkdir -p /opt/servarr"
    tar -C $PSScriptRoot -cf - servarr-ui | wsl -d $DistroName -u root -- bash -lc "tar -xf - -C /opt/servarr"

    Write-Host "[2/4] Ensuring compose service exists..."
    # Build bash script by constructing it line by line to avoid PowerShell parsing
    $lt = '<'  # Less than character to avoid operator parsing
    $gt = '>'  # Greater than character
    $bashScriptLines = @(
        'set -euo pipefail',
        'mkdir -p /srv/config/servarr-ui',
        'if ! grep -q "servarr_ui:" /opt/servarr/compose.yml; then',
        "cat >>/opt/servarr/compose.yml $lt$lt"+'BASHEOF',
        '',
        '  servarr_ui:',
        '    build: ./servarr-ui',
        '    container_name: servarr_ui',
        '    environment:',
        '      - PORT=5055',
        '      - CONFIG_PATH=/data/config.json',
        '    volumes:',
        '      - /var/run/docker.sock:/var/run/docker.sock',
        '      - /srv/config/servarr-ui:/data',
        '      - /opt/servarr:/opt/servarr',
        '    ports:',
        '      - "5055:5055"',
        '    restart: unless-stopped',
        'BASHEOF',
        'fi'
    )
    $bashScript = $bashScriptLines -join [System.Environment]::NewLine
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bashScript))
    & wsl -d $DistroName -u root -- bash -c "echo $encoded | base64 -d | bash"

    Write-Host "[3/4] Building and starting custom UI..."
    & wsl -d $DistroName -- bash -lc "cd /opt/servarr && docker compose up -d --build servarr_ui"

    Write-Host "[4/4] Done." -ForegroundColor Green
    Write-Host "UI updated: http://localhost:5055"
}

# ============================================================================
# UNINSTALL ACTION
# ============================================================================

elseif ($Action -eq "Uninstall") {
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
            Write-Host "=== Servarr WSL Uninstall Options ===" -ForegroundColor Cyan
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

        Write-Host "[1/4] Stopping and removing Servarr containers from '$DistroName'..."
    $orOp = $null; $orOp = [char]124 + [char]124  # || operator
        $cleanupScript = @(
            'set -euo pipefail',
            '',
            'if command -v docker >/dev/null 2>&1; then',
            '  if [ -f /opt/servarr/compose.yml ]; then',
            "    docker compose -f /opt/servarr/compose.yml down --remove-orphans $orOp true",
            '  fi',
            '',
            '  if [ -f /opt/servarr/compose.apps.yml ]; then',
            "    docker compose -f /opt/servarr/compose.apps.yml down --remove-orphans $orOp true",
            '  fi',
            '',
            "  docker rm -f servarr_ui sonarr radarr sabnzbd >/dev/null 2>&1 $orOp true",
            'fi'
        ) -join "`n"
        if ($PSCmdlet.ShouldProcess($DistroName, "Stop and remove Servarr containers")) {
            Invoke-WslRoot -Distro $DistroName -Script $cleanupScript
        }

        if ($PurgeData) {
            Write-Host "[2/4] Purging Servarr data directories in distro..."
            $purgeScript = @(
                'set -euo pipefail',
                'rm -rf /srv/config/servarr-ui /srv/config/sonarr /srv/config/radarr /srv/config/sabnzbd',
                'rm -rf /srv/downloads /srv/media',
                'rm -f /opt/servarr/compose.apps.yml'
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

            Write-Host "Removed distro '$DistroName'." -ForegroundColor Green
        } else {
            Write-Host "[4/4] Done." -ForegroundColor Green
            Write-Host "Distro kept. Re-run with -RemoveDistro to fully uninstall it."
        }
    }
}

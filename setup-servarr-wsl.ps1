[CmdletBinding()]
param(
    [string]$RootFsTar,

    [string]$DistroName = "servarr-wsl",
    [string]$InstallPath = "C:\WSL\servarr-wsl",
    [string]$LinuxUser = "servarr",
    [string]$TimeZone = "America/New_York",
  [string]$RootFsDownloadUrl = "https://cloud-images.ubuntu.com/wsl/noble/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz",
  [string]$DownloadDir = "$PSScriptRoot\.cache",
  [switch]$AutoDownloadRootFs = $true,
    [switch]$ForceRecreate
)

$ErrorActionPreference = "Stop"

function Invoke-Wsl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Distro,
        [Parameter(Mandatory = $true)]
        [string]$Script
    )

    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
    $cmd = "echo $encoded | base64 -d | bash"
    & wsl -d $Distro -u root -- bash -lc $cmd
}

Write-Host "[1/7] Checking prerequisites..."
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    throw "WSL is not available. Install WSL first (wsl --install), reboot, then retry."
}

if ([string]::IsNullOrWhiteSpace($RootFsTar)) {
  if (-not $AutoDownloadRootFs) {
    throw "RootFsTar is required when -AutoDownloadRootFs is disabled."
  }

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
}

Write-Host "[3/7] Importing dedicated distro '$DistroName'..."
New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
& wsl --import $DistroName $InstallPath $RootFsTar --version 2

Write-Host "[4/7] Bootstrapping base Linux user + systemd..."
$bootstrapSystemd = @"
set -euo pipefail

if ! id -u '$LinuxUser' >/dev/null 2>&1; then
  useradd -m -s /bin/bash '$LinuxUser'
fi

mkdir -p /etc/sudoers.d
cat >/etc/sudoers.d/90-$LinuxUser <<'EOF'
$LinuxUser ALL=(ALL) NOPASSWD:ALL
EOF
chmod 0440 /etc/sudoers.d/90-$LinuxUser

cat >/etc/wsl.conf <<'EOF'
[boot]
systemd=true

[user]
default=$LinuxUser
EOF
"@
Invoke-Wsl -Distro $DistroName -Script $bootstrapSystemd

Write-Host "[5/7] Restarting distro to apply systemd..."
& wsl --terminate $DistroName
Start-Sleep -Seconds 2

Write-Host "[6/7] Copying custom web UI sources into distro..."
& wsl -d $DistroName -u root -- bash -lc "mkdir -p /opt/servarr"
tar -C $PSScriptRoot -cf - servarr-ui | wsl -d $DistroName -u root -- bash -lc "tar -xf - -C /opt/servarr"

Write-Host "[7/7] Installing Docker Engine + Compose + minimal Servarr UI..."
$installStack = @"
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release
ARCH=\$(dpkg --print-architecture)
echo "deb [arch=\$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \$VERSION_CODENAME stable" >/etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

usermod -aG docker '$LinuxUser'

mkdir -p /opt/servarr
mkdir -p /srv/config/servarr-ui
chown -R '$LinuxUser':'$LinuxUser' /opt/servarr /srv

cat >/opt/servarr/compose.yml <<EOF
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
      - /srv/config/servarr-ui:/data
      - /opt/servarr:/opt/servarr
    ports:
      - "5055:5055"
    restart: unless-stopped
EOF

cd /opt/servarr
docker compose pull
docker compose up -d --build
"@
Invoke-Wsl -Distro $DistroName -Script $installStack

Write-Host "Completed."
Write-Host ""
Write-Host "Apps:"
Write-Host "  ServarrUI http://localhost:5055"
Write-Host ""
Write-Host "Open shell: wsl -d $DistroName"
Write-Host "Stack file: /opt/servarr/compose.yml"
Write-Host ""
Write-Host "Tip: Install Sonarr/Radarr/SABnzbd from the web UI first-run setup page."

[CmdletBinding()]
param(
    [string]$DistroName = "servarr-wsl"
)

$ErrorActionPreference = "Stop"

$uiPath = Join-Path $PSScriptRoot "servarr-ui"
if (-not (Test-Path -LiteralPath $uiPath)) {
    throw "Custom UI project not found: $uiPath"
}

$existing = wsl -l -q
if ($existing -notcontains $DistroName) {
    throw "Distro '$DistroName' not found."
}

Write-Host "[1/4] Copying UI sources..."
& wsl -d $DistroName -u root -- bash -lc "mkdir -p /opt/servarr"
tar -C $PSScriptRoot -cf - servarr-ui | wsl -d $DistroName -u root -- bash -lc "tar -xf - -C /opt/servarr"

Write-Host "[2/4] Ensuring compose service exists..."
$composePatch = @"
set -euo pipefail
mkdir -p /srv/config/servarr-ui
if ! grep -q "servarr_ui:" /opt/servarr/compose.yml; then
cat >>/opt/servarr/compose.yml <<'EOF'

  servarr_ui:
    build: ./servarr-ui
    container_name: servarr_ui
    environment:
      - PORT=5055
      - CONFIG_PATH=/data/config.json
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv/config/servarr-ui:/data
      - /opt/servarr:/opt/servarr
    ports:
      - "5055:5055"
    restart: unless-stopped
EOF
fi
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($composePatch))
& wsl -d $DistroName -u root -- bash -lc "echo $encoded | base64 -d | bash"

Write-Host "[3/3] Building and starting custom UI..."
& wsl -d $DistroName -- bash -lc "cd /opt/servarr && docker compose up -d --build servarr_ui"

Write-Host "Done: http://localhost:5055"

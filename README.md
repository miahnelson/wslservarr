# WSLServarr

Automated WSL2 installer for a media server stack with Sonarr, Radarr, and SABnzbd, plus a web UI and mobile API.

## Prerequisites

- Windows 10/11 with WSL2
- PowerShell 5.1+
- 2GB disk space
- Ports 5055, 8989, 7878, 8080 available

## Quick Start

```powershell
.\wslservarr.ps1
```

The script will:
1. Ask for a single Windows root folder and create `config`, `media`, `downloads`
2. Create WSL distro with Docker
3. Mount Windows folders into WSL
4. Deploy WSLServarr UI to http://localhost:5055

## Commands

```powershell
# Setup (interactive)
.\wslservarr.ps1

# Update UI only
.\wslservarr.ps1 -Action Update

# Full reinstall
.\wslservarr.ps1 -Action Reinstall

# Uninstall
.\wslservarr.ps1 -Action Uninstall
```

## Folders

Default Windows folders created and mounted into WSL:

```
C:\Users\<You>\WslServarrData\config     → /mnt/config
C:\Users\<You>\WslServarrData\media      → /mnt/media
C:\Users\<You>\WslServarrData\downloads  → /mnt/downloads
```

## Web Interfaces

- **WSLServarr UI**: http://localhost:5055
- **Sonarr**: http://localhost:8989 (if enabled)
- **Radarr**: http://localhost:7878 (if enabled)
- **SABnzbd**: http://localhost:8080 (if enabled)

## Troubleshooting

```powershell
wsl -d wslservarr-wsl docker ps
wsl -d wslservarr-wsl docker logs wslservarr_ui
wsl -d wslservarr-wsl mount | grep /mnt
```

## Files

- `wslservarr.ps1` — Main installer entrypoint
- `servarr.ps1` — Backward-compatible installer script
- `wslservarr-ui/` — Node.js web UI/API
- `wslservarr-mobile/` — React Native (Expo) mobile app

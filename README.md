# WSLServarr

Automated WSL2 installer for a media server stack with Sonarr, Radarr, and SABnzbd, plus a web UI.

## Prerequisites

- Windows 10/11 with WSL2
- PowerShell 5.1+
- 2GB disk space
- Ports 5055, 8989, 7878, 8080 available

## Quick Start

```powershell
.\wslservarr.ps1
```

When no action is provided, the script defaults to **Run app** after 5 seconds.

The script will:
1. Ask for a single Windows root folder and create `config`, `media`, `downloads`
2. Create WSL distro with Docker
3. Mount Windows folders into WSL
4. Deploy WSLServarr UI from GitHub to http://localhost:5055

Web UI source repo (default):

`https://github.com/miahnelson/wslservarr.git` (branch `main`)

## Commands

```powershell
# Setup (interactive)
.\wslservarr.ps1

# Run app (keep UI running)
.\wslservarr.ps1 -Action Run

# Restart all services in the stack
.\wslservarr.ps1 -Action RestartAll

# Update UI only (production: pulls from GitHub)
.\wslservarr.ps1 -Action Update

# Update UI only (development: sync local working copy)
.\wslservarr.ps1 -Action Update -DevMode

# Use custom repo/branch for UI source
.\wslservarr.ps1 -Action Update -WebUiRepoUrl https://github.com/miahnelson/wslservarr.git -WebUiRepoBranch main

# Full reinstall
.\wslservarr.ps1 -Action Reinstall

# Uninstall
.\wslservarr.ps1 -Action Uninstall
```

After **Setup**, the script enters run mode and keeps printing UI status + URL until you press `Ctrl+C`.

`Update` finishes after rebuild/deploy and returns to the prompt.

## Folders

Default Windows folders created and mounted into WSL:

```
C:\wslservarr\config     → /mnt/config
C:\wslservarr\media      → /mnt/media
C:\wslservarr\downloads  → /mnt/downloads
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
- `wslservarr-ui/` — Node.js API + React web UI

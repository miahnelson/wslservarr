# Servarr WSL

Automated WSL2 installer for a media server stack with Sonarr, Radarr, and SABnzbd, plus a web UI for management.

## Prerequisites

- Windows 10/11 with WSL2
- PowerShell 5.1+
- 2GB disk space
- Ports 5000, 8989, 7878, 8080 available

## Quick Start

```powershell
.\servarr.ps1
```

The script will:
1. Ask for Windows folder paths (config, media, downloads)
2. Create WSL distro with Docker
3. Mount Windows folders into WSL
4. Deploy web UI to http://localhost:5000

Complete the setup wizard that appears in your browser.

## Commands

```powershell
# Setup (interactive)
.\servarr.ps1

# Update UI only
.\servarr.ps1 -Action Update

# Full reinstall
.\servarr.ps1 -Action Setup -ForceRecreate

# Uninstall
.\servarr.ps1 -Action Uninstall
```

## Folders

After setup, these Windows folders are created and mounted into WSL:

```
C:\Users\<You>\ServarrConfig     → /mnt/config
C:\Users\<You>\ServarrMedia      → /mnt/media
C:\Users\<You>\ServarrDownloads  → /mnt/downloads
```

## Web Interfaces

- **Servarr UI**: http://localhost:5000 (configuration & management)
- **Sonarr**: http://localhost:8989 (if enabled)
- **Radarr**: http://localhost:7878 (if enabled)
- **SABnzbd**: http://localhost:8080 (if enabled)

## Troubleshooting

**WSL not found:**
```powershell
wsl --install
```

**Web UI not responding:**
```powershell
wsl -d servarr-wsl docker ps
wsl -d servarr-wsl docker logs servarr_ui
```

**Folders not mounting:**
```powershell
wsl --shutdown
wsl -d servarr-wsl mount | grep /mnt
```

## Files

- `servarr.ps1` — Main installer script
- `servarr-ui/` — Node.js web application
  - `server.js` — Express backend
  - `views/` — EJS templates (dashboard + wizard)
  - `public/styles.css` — Modern UI styling

---

**Status**: Production-ready | **Setup time**: 2-3 min | **Memory**: ~300-500MB

# Servarr WSL (Windows 11)

Minimal, isolated WSL2 setup for:
- Custom `Servarr UI` web app
- Optional Sonarr / Radarr / SABnzbd installed from that UI

No Docker Desktop or Portainer required.

## What this project contains

- `setup-servarr-wsl.ps1` — creates dedicated WSL distro and deploys only the custom web UI
- `deploy-servarr-ui.ps1` — updates/redeploys only the custom web UI to an existing distro
- `uninstall-servarr-wsl.ps1` — removes containers and optionally data/distro
- `servarr-ui/` — Node.js web app source + Docker image build files

## Prerequisites

1. Windows 11 with WSL available
2. PowerShell session opened in this folder

## 1) Initial install

Run:

```powershell
.\setup-servarr-wsl.ps1
```

By default, the installer will download the Ubuntu WSL rootfs automatically into `.\.cache`.

If you already have a local rootfs tar, you can still use:

```powershell
.\setup-servarr-wsl.ps1 -RootFsTar "C:\Install\ubuntu-rootfs.tar"
```

Optional parameters:

- `-DistroName` (default: `servarr-wsl`)
- `-InstallPath` (default: `C:\WSL\servarr-wsl`)
- `-LinuxUser` (default: `servarr`)
- `-TimeZone` (default: `America/New_York`)
- `-RootFsDownloadUrl` (override default Ubuntu rootfs URL)
- `-DownloadDir` (default: `.\.cache`)
- `-ForceRecreate` (replaces an existing distro with same name)

After completion, open:

- `http://localhost:5055`

## 2) First-time web UI flow

1. Open `http://localhost:5055`
2. Enter runtime/config values (timezone, PUID/PGID, paths, URLs/API keys as available)
3. Click **Install / Update Sonarr + Radarr + SABnzbd**
4. Once containers are running, add Sonarr/Radarr/SAB API keys in the form
5. Click **Apply to Arr Apps** to push basic integration settings (download client + root folders)

## 3) Update/redeploy only the custom UI

Use this when you changed files in `servarr-ui/`:

```powershell
.\deploy-servarr-ui.ps1
```

Optional:

- `-DistroName` (default: `servarr-wsl`)

## 4) Uninstall options

### Remove containers only (keep distro + data)

```powershell
.\uninstall-servarr-wsl.ps1
```

### Remove containers and purge app data

```powershell
.\uninstall-servarr-wsl.ps1 -PurgeData
```

### Full uninstall (remove distro)

```powershell
.\uninstall-servarr-wsl.ps1 -RemoveDistro
```

### Full uninstall + purge data

```powershell
.\uninstall-servarr-wsl.ps1 -RemoveDistro -PurgeData
```

The uninstall script supports `-WhatIf` and `-Confirm`.

## Notes

- Everything runs inside one dedicated WSL distro for isolation.
- Port conflicts on Windows still apply (e.g., if `5055`, `8080`, `7878`, `8989` are already in use).
- App data is stored in `/srv` inside the distro.

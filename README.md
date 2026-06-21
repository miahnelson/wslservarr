# WSLServarr

WSLServarr is a Windows-first WSL2 installer and manager for a self-hosted media stack. It creates a dedicated WSL distro, installs Docker inside that distro, mounts your Windows media folders, and serves a web UI that can deploy and relink supported apps.

Supported apps:

- Sonarr
- Radarr
- SABnzbd
- Prowlarr
- Jellyfin

## What WSLServarr does

The installer script:

1. Creates a dedicated WSL distro named `wslservarr-wsl`
2. Installs Docker Engine and Docker Compose inside that distro
3. Creates and mounts Windows folders for config, media, and downloads
4. Deploys the WSLServarr web UI on port `5055`
5. Optionally registers WSLServarr to start automatically with Windows
6. Lets the web UI deploy and configure the app stack from one place
7. Checks GitHub for a newer `wslservarr.ps1` and updates the local script before continuing

No Docker Desktop is required.

## Requirements

### Windows requirements

- Windows 10 or Windows 11
- WSL2 support enabled
- Virtualization enabled in BIOS/UEFI if your machine requires it
- PowerShell 5.1 or newer
- Administrator PowerShell session for setup, run, update, restart, and startup configuration
- Internet access during setup unless you provide your own rootfs tarball and already have the UI source available

### Ports

Make sure these ports are free if you plan to use the corresponding apps:

- `5055` - WSLServarr UI
- `8080` - SABnzbd
- `8989` - Sonarr
- `7878` - Radarr
- `9696` - Prowlarr
- `8096` - Jellyfin

### Disk space

Minimum:

- At least 2 GB free for a basic install

Recommended:

- More space for Docker images, app configs, downloads, and your media library

## Dependencies

### Dependencies you must have installed first

Install these before running setup:

1. **WSL**
2. **A reboot after WSL installation**, if Windows asks for it

Install WSL from an elevated PowerShell session:

```powershell
wsl --install
```

After reboot, verify WSL is available:

```powershell
wsl --status
wsl -l -v
```

If script execution is blocked in your current PowerShell session, allow it temporarily:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

### Dependencies installed automatically by WSLServarr

The script installs these inside the dedicated WSL distro for you:

- Ubuntu-based WSL root filesystem
- Docker Engine
- Docker Compose plugin
- Git
- curl
- gnupg
- lsb-release
- libsecret-1-0
- gnome-keyring

You do not need to install those manually on Windows.

## Detailed install instructions

### 1. Get the project

Clone or download this repository to a local Windows folder.

Example:

```powershell
git clone https://github.com/miahnelson/wslservarr.git
cd .\wslservarr
```

### 2. Open PowerShell as Administrator

This is required because the script manages:

- Windows firewall rules
- `netsh interface portproxy` LAN forwarding
- the optional Windows startup scheduled task

### 3. Start the installer

Run:

```powershell
.\wslservarr.ps1
```

If you do not choose an action, the script defaults to `Run` after 5 seconds. On a first install, choose `Setup`.

On normal runs, the script first checks the configured GitHub repo for a newer copy of `wslservarr.ps1`.
If it updates itself, it exits and asks you to run the command again so the new version is used for the current session.

### 4. Pick your Windows data root

Setup asks for a single Windows root folder. Under that folder, WSLServarr creates:

- `config`
- `media`
- `downloads`

Default example:

```text
C:\wslservarr\config
C:\wslservarr\media
C:\wslservarr\downloads
```

These are mounted in WSL as:

```text
/mnt/config
/mnt/media
/mnt/downloads
```

### 5. Choose whether WSLServarr starts with Windows

Setup asks whether Windows auto-start should be enabled.

If you choose yes, the script creates a scheduled task named **WSLServarr Startup**.

You can change this later at any time with:

```powershell
.\wslservarr.ps1 -Action Startup
```

### 6. Let setup finish

During setup, the script will:

- reuse an exported rootfs from an existing `Ubuntu` WSL distro if available, or download one automatically
- import the dedicated `wslservarr-wsl` distro
- enable `systemd`
- create the `wslservarr` Linux user
- mount your Windows folders through `/etc/fstab`
- install Docker and Docker Compose inside WSL
- clone or sync the web UI source into `/opt/wslservarr/src`
- build and start the `wslservarr_ui` container

After setup, the script enters run mode and keeps the environment warm until you press `Ctrl+C`.

### 7. Open the UI

Default UI URL:

- http://localhost:5055

If LAN forwarding is active, the UI also becomes reachable from other devices on your network by your Windows host IP.

### 8. Complete first-run app setup in the UI

The web UI is the main control surface for deploying apps.

Current first-run behavior includes:

- detection of which supported apps are already deployed
- deployment or startup of apps that are enabled but not running
- relinking of supported integrations where possible
- Jellyfin first-start automation, including optional initial admin username and password

Typical flow:

1. Open the UI
2. Enable the apps you want
3. Save configuration
4. Let the UI deploy and relink the stack

## Storage and install locations

### Windows data root

Default:

```text
C:\wslservarr
```

### WSL distro / VHDX location

By default, the WSL distro install path follows the drive you choose for the Windows data root.

Examples:

- If your root is `C:\wslservarr`, the distro path defaults to `C:\WSL\wslservarr-wsl`
- If your root is `D:\wslservarr`, the distro path defaults to `D:\WSL\wslservarr-wsl`

The actual WSL virtual disk is typically:

```text
<InstallPath>\ext4.vhdx
```

The script stores the resolved install settings in `.wslservarr-install.json` so later runs and uninstall actions use the same paths.

## Commands

### Interactive menu

```powershell
.\wslservarr.ps1
```

Menu options:

1. `Run`
2. `Setup`
3. `Update`
4. `RestartAll`
5. `Uninstall`
6. `Reinstall`
7. `Startup`

### Direct actions

```powershell
# Run app and keep the UI/container warm
.\wslservarr.ps1 -Action Run

# Install from scratch
.\wslservarr.ps1 -Action Setup

# Restart all stack services
.\wslservarr.ps1 -Action RestartAll

# Enable or disable start with Windows
.\wslservarr.ps1 -Action Startup

# Update UI only from GitHub
.\wslservarr.ps1 -Action Update

# Update UI only from the local working tree
.\wslservarr.ps1 -Action Update -DevMode

# Update UI from a custom GitHub repo/branch
.\wslservarr.ps1 -Action Update -WebUiRepoUrl https://github.com/miahnelson/wslservarr.git -WebUiRepoBranch main

# Recreate the distro and reinstall everything
.\wslservarr.ps1 -Action Reinstall

# Uninstall interactively
.\wslservarr.ps1 -Action Uninstall
```

### Self-update behavior

- Automatic self-update is enabled for normal GitHub-based usage
- Self-update is skipped in `-DevMode`
- Self-update is skipped if you supply a local source path
- Self-update can be skipped manually for one run with `-SkipSelfUpdate`
- The previous script is backed up as `wslservarr.ps1.bak`

### Useful setup parameters

```powershell
# Use a custom Windows data root
.\wslservarr.ps1 -Action Setup -DataRootPath D:\wslservarr

# Override the WSL distro install path explicitly
.\wslservarr.ps1 -Action Setup -DataRootPath D:\wslservarr -InstallPath D:\CustomWSL\wslservarr-wsl

# Use a local repo copy for UI deployment during development
.\wslservarr.ps1 -Action Setup -DevMode

# Use a custom Linux rootfs tarball
.\wslservarr.ps1 -Action Setup -RootFsTar C:\path\to\ubuntu-rootfs.tar
```

## Default app URLs

- **WSLServarr UI**: http://localhost:5055
- **SABnzbd**: http://localhost:8080
- **Prowlarr**: http://localhost:9696
- **Sonarr**: http://localhost:8989
- **Radarr**: http://localhost:7878
- **Jellyfin**: http://localhost:8096

App URLs are only live when those apps are enabled and deployed.

## Updating

Production-style UI update:

```powershell
.\wslservarr.ps1 -Action Update
```

Development update from the local workspace:

```powershell
.\wslservarr.ps1 -Action Update -DevMode
```

`Update` rebuilds and redeploys the UI container, then returns to the prompt.

## Uninstall behavior

Running uninstall removes the Windows startup task if it exists.

```powershell
.\wslservarr.ps1 -Action Uninstall
```

Interactive uninstall can:

- stop and remove WSLServarr containers
- optionally purge in-distro service data
- optionally unregister the WSL distro and remove the VHDX install path

Important:

- Your Windows data root is not automatically deleted by the current uninstall flow
- If you want to remove `C:\wslservarr` or `D:\wslservarr`, delete it manually after uninstall

## Troubleshooting

### Verify WSL is installed

```powershell
wsl --status
wsl -l -v
```

### Check running containers

```powershell
wsl -d wslservarr-wsl docker ps
```

### Check the UI container logs

```powershell
wsl -d wslservarr-wsl docker logs wslservarr_ui
```

### Check mounted Windows folders inside WSL

```powershell
wsl -d wslservarr-wsl mount | grep /mnt
```

### Restart everything

```powershell
.\wslservarr.ps1 -Action RestartAll
```

### Rebuild the UI

```powershell
.\wslservarr.ps1 -Action Update
```

### Common issues

- **"WSL is not available"**: run `wsl --install`, reboot, and try again
- **Access denied / firewall / portproxy errors**: rerun PowerShell as Administrator
- **Port already in use**: stop the conflicting app or change the configured port in the web UI
- **Rootfs download problems**: provide `-RootFsTar` manually or verify internet access
- **App not reachable on LAN**: rerun `Run` or `RestartAll` as Administrator so firewall and portproxy rules can be refreshed

## Repository layout

- `wslservarr.ps1` - main Windows installer and manager
- `wslservarr-ui/` - Node/Express backend and React frontend for the web UI
- `wslservarr-ui/config.sample.json` - sample app configuration

## Notes

- The script defaults to `Run` after 5 seconds when no action is chosen
- `Run`, `Setup`, `Update`, `RestartAll`, and `Startup` require Administrator privileges
- The startup setting can be changed any time with `-Action Startup`

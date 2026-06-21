# LLM Context: Running and Debugging WSLServarr

This document is for an LLM or coding agent working on this repository. It explains what the project is, how it is run, where the important code lives, and how to debug common problems.

## Project summary

WSLServarr is a Windows-first WSL2 media-stack manager.

It consists of:

- a PowerShell installer/orchestrator: `wslservarr.ps1`
- a web UI project: `wslservarr-ui/`
  - React frontend: `wslservarr-ui/src/App.jsx`
  - Node/Express backend: `wslservarr-ui/server.js`
- Docker containers for supported apps:
  - `sabnzbd`
  - `prowlarr`
  - `sonarr`
  - `radarr`
  - `jellyfin`
  - `wslservarr_ui`

The PowerShell script creates or manages a dedicated WSL distro, installs Docker inside it, mounts Windows folders into WSL, and deploys the UI container. The UI then manages app deployment, restart, relink, and first-run configuration.

## Important architecture notes

### 1. There are two environments to keep straight

There is often a mismatch between:

- the local source code in this workspace
- the currently running UI/backend inside WSL on the target machine

Editing files in this repository does **not** affect the running system until the UI is redeployed.

If behavior does not match the code, the first suspicion should be: **the running container is stale**.

### 2. The UI backend runs inside Docker in WSL

The backend file `wslservarr-ui/server.js` is not run directly from Windows during normal use.
It is copied or cloned into WSL under:

- `/opt/wslservarr/src/wslservarr-ui`

and then built into the `wslservarr_ui` container.

### 3. Distro name may differ from the default

The script default distro name is `wslservarr-wsl`, but real systems may be using a different one, such as `servarr-wsl`.

Always verify the actual distro list before assuming the default:

```powershell
wsl -l -q
```

If a command fails with `Distro 'wslservarr-wsl' not found`, inspect the registered distro names and adapt.

### 4. Local vs remote UI access matters

If the user is browsing a remote system at a URL like `http://192.168.x.x/`, then fixes made in the local workspace only matter after that remote machine is updated and redeployed.

### 5. Self-update can change the script while debugging

`wslservarr.ps1` can now self-update from GitHub before continuing.

Implications:

- if the script updates itself, it exits and must be rerun
- local PowerShell edits may be replaced during a normal run
- during development, prefer `-SkipSelfUpdate` or `-DevMode`

### 6. Container presence and config state are related but not identical

The backend can infer `enabled` state from running or existing containers.

That means:

- a container may restart even if the saved config was incomplete
- relink may still skip integration work if required API keys are absent
- restart success does **not** prove relink prerequisites were met

## Known pitfalls

- assuming the running machine is the same as the local workspace machine
- assuming the running backend already contains the latest code
- assuming the distro name is always `wslservarr-wsl`
- assuming restart and relink use the same prerequisites
- assuming frontend-only URL problems are not caused by stale backend data
- forgetting that `wslservarr.ps1` may self-update and exit before doing the requested action

## Key files

### Root

- `wslservarr.ps1`
  - main installer/runner/update/uninstall entrypoint
  - manages WSL distro creation, Docker install, startup task, and UI deployment
- `.wslservarr-install.json`
  - stores resolved install metadata such as data root, install path, and distro name
- `README.md`
  - user-facing documentation
- `LLM_CONTEXT.md`
  - this file

### Web UI project

- `wslservarr-ui/server.js`
  - Node/Express API
  - Docker orchestration and relink logic
  - config normalization and persistence
  - first-start automation
  - Jellyfin setup automation
- `wslservarr-ui/src/App.jsx`
  - main React app
  - dashboard, config modal, deployment modal, URL rendering
- `wslservarr-ui/src/react-ui.css`
  - UI styling
- `wslservarr-ui/config.sample.json`
  - sample persisted app config
- `wslservarr-ui/package.json`
  - UI/backend package metadata and scripts

## Supported app defaults

Default app ports:

- UI: `5055`
- SABnzbd: `8080`
- Prowlarr: `9696`
- Sonarr: `8989`
- Radarr: `7878`
- Jellyfin: `8096`

Default internal service URLs in the app config use Docker service names, for example:

- `http://sonarr:8989`
- `http://radarr:7878`
- `http://sabnzbd:8080`
- `http://prowlarr:9696`
- `http://jellyfin:8096`

## Where runtime data lives

### Windows side

The chosen Windows data root contains:

- `config`
- `media`
- `downloads`

Typical example:

```text
D:\wslservarr
```

### WSL side

The Windows folders are mounted as:

- `/mnt/config`
- `/mnt/media`
- `/mnt/downloads`

### WSL distro install path

The WSL distro VHDX usually lives under a path like:

```text
D:\WSL\wslservarr-wsl\ext4.vhdx
```

The actual resolved paths should be taken from `.wslservarr-install.json` when present.

## Path map for debugging

### Windows host paths

- script root: `C:\Users\<user>\...\servarr_windows`
- install settings: `.wslservarr-install.json`
- script backup after self-update: `wslservarr.ps1.bak`
- data root example: `D:\wslservarr`
- WSL install path example: `D:\WSL\wslservarr-wsl`

### WSL filesystem paths

- UI source root: `/opt/wslservarr/src/wslservarr-ui`
- main UI compose: `/opt/wslservarr/compose.yml`
- app compose: `/opt/wslservarr/compose.apps.yml`
- mounted config root: `/mnt/config`
- mounted media root: `/mnt/media`
- mounted downloads root: `/mnt/downloads`

### Per-app config paths inside WSL

- Sonarr: `/mnt/config/sonarr/config.xml`
- Radarr: `/mnt/config/radarr/config.xml`
- Prowlarr: `/mnt/config/prowlarr/config.xml`
- SABnzbd: `/mnt/config/sabnzbd/sabnzbd.ini`
- Jellyfin: `/mnt/config/jellyfin`

### Container names

- `wslservarr_ui`
- `sabnzbd`
- `prowlarr`
- `sonarr`
- `radarr`
- `jellyfin`

## How to run the project

## A. Normal user flow

Run the installer/manager:

```powershell
.\wslservarr.ps1
```

Main actions:

- `Run`
- `Setup`
- `Update`
- `RestartAll`
- `Uninstall`
- `Reinstall`
- `Startup`

## B. Setup from scratch

```powershell
.\wslservarr.ps1 -Action Setup
```

What setup does:

1. checks WSL availability
2. asks for the Windows data root
3. derives the WSL install path from the selected drive unless overridden
4. optionally configures startup-with-Windows
5. imports or downloads a Linux rootfs
6. creates the dedicated WSL distro
7. enables `systemd`
8. mounts Windows folders into WSL
9. installs Docker Engine and Docker Compose in WSL
10. deploys the `wslservarr_ui` container
11. enters run mode

## C. Run mode

```powershell
.\wslservarr.ps1 -Action Run
```

Run mode:

- ensures Docker is running in WSL
- ensures the UI container is running
- syncs Windows firewall and `netsh portproxy` rules
- starts a hidden keepalive WSL session
- prints periodic status

## D. Update the running UI

### Production-style update

```powershell
.\wslservarr.ps1 -Action Update
```

This refreshes UI source from GitHub and rebuilds the `wslservarr_ui` container.

### Development update from the local workspace

```powershell
.\wslservarr.ps1 -Action Update -DevMode
```

This is the main command to use after editing frontend or backend files in this repository.

If the code change is not visible in the running app, this step was probably missed.

## E. Restart app containers

```powershell
.\wslservarr.ps1 -Action RestartAll
```

This restarts the stack from the PowerShell side.

Inside the UI/backend, app restarts may also be triggered through API routes and Docker compose actions.

## F. Change Windows startup behavior

```powershell
.\wslservarr.ps1 -Action Startup
```

This toggles the Windows scheduled task named `WSLServarr Startup`.

## Development workflow

### When editing PowerShell only

If changes are only in `wslservarr.ps1`, rerun the script directly.

If self-update is interfering during development, use:

```powershell
.\wslservarr.ps1 -SkipSelfUpdate
```

or use `-DevMode` where appropriate.

### When editing the UI or backend

After changing files in `wslservarr-ui/`, redeploy the UI:

```powershell
.\wslservarr.ps1 -Action Update -DevMode
```

This rebuilds and restarts the `wslservarr_ui` container using the local workspace source.

### When working against a remote machine

If the user is browsing WSLServarr on another machine:

- local edits here will not change that remote system
- the remote machine must pull or sync the updated source
- the UI/backend container on the remote machine must be rebuilt

## How to verify what is actually running

### 1. Check the registered WSL distros

```powershell
wsl -l -q
```

Do not assume the distro is always `wslservarr-wsl`.

### 2. Read saved install settings

```powershell
Get-Content .\.wslservarr-install.json -Raw
```

This shows:

- `dataRootPath`
- `installPath`
- `distroName`

### 3. Check whether the UI source in WSL contains a code change

Example pattern:

```powershell
wsl -d <distro> -- bash -lc "grep -n 'someNewFunctionName' /opt/wslservarr/src/wslservarr-ui/server.js"
```

If the grep returns nothing, the running WSL source is stale.

### 4. Check the UI container status

```powershell
wsl -d <distro> -- docker ps
```

### 5. Check UI container logs

```powershell
wsl -d <distro> -- docker logs wslservarr_ui
```

## Important runtime APIs

These endpoints are useful for debugging:

- `GET /api/bootstrap`
  - returns config, container status, deploy state, and now also LAN host info
- `GET /api/containers`
  - returns container status summary
- `POST /api/config`
  - saves config
- `POST /api/compose`
  - saves top-level compose content
- `GET /api/yaml/:appName`
  - returns the normalized service YAML for a single app
- `POST /api/yaml/:appName`
  - saves service YAML for a single app and syncs config from it
- `POST /api/test/:appName`
  - tests one app connection using the saved URL and API key
- `POST /api/apply`
  - runs relink/apply flow
- `POST /api/install/apps/:appName/start`
  - deploys or starts one app
- `POST /api/install/apps/restart`
  - restarts all enabled apps through the backend
- `POST /api/install/apps/:appName/restart`
  - restarts one app through the backend

If a feature is failing in the UI, check whether the corresponding backend route returns the expected JSON.

## Config model summary

The persisted config is centered around these sections:

- `sonarr`
- `radarr`
- `sabnzbd`
- `prowlarr`
- `jellyfin`
- `paths`
- `runtime`
- `setup`
- `composeYaml`

Important fields:

- `enabled`
- `url`
- `apiKey`
- `port`
- app-specific roots or categories
- `composeYaml`

Important `setup` fields:

- `setup.completed`
  - `false` means first-start initialization can still run
- `setup.completedAt`
  - timestamp for when initialization finished

API key notes:

- saved config may not always contain every key immediately
- backend can now recover missing keys from app config files on disk for Sonarr, Radarr, Prowlarr, and SABnzbd
- if behavior suggests keys are still missing, verify the running backend actually includes that code

## Failure signatures and what they usually mean

### `Distro 'wslservarr-wsl' not found`

Usually means the real distro name differs from the default.

Check:

- `wsl -l -q`
- `.wslservarr-install.json`

### `Skipping sonarr auto-config (app disabled or API key missing)`

Usually means one of these is true:

- the app is genuinely disabled
- the saved config lacks the API key
- the running backend is stale and does not include key recovery logic

### `Skipping Prowlarr relink (Prowlarr disabled or API key missing)`

Usually means:

- Prowlarr is disabled
- Prowlarr API key is absent in config and was not recovered
- the backend being executed is older than the workspace code

### UI does not show IPv4/LAN URLs

Usually means one of these:

- browser is on a remote host and that host is running stale code
- backend `GET /api/bootstrap` is not returning `networkHost`
- frontend/browser host detection is not the code currently deployed

### Startup task exists but never ran

Check `LastTaskResult` and `LastRunTime` via Task Scheduler or PowerShell.

Common explanation:

- the task is registered but the machine has not rebooted yet

## Deployment and action matrix

Use this when deciding what command or route to run.

- edit only `wslservarr.ps1`
  - rerun the script directly
- edit `wslservarr-ui/src/*` or `wslservarr-ui/server.js`
  - run `-Action Update -DevMode`
- need to refresh only app integrations
  - call `POST /api/apply`
- need to recreate app containers from the backend
  - use `POST /api/install/apps/restart` or the per-app variant
- need to refresh Windows portproxy/firewall state
  - run `-Action Run` or `-Action RestartAll` as Administrator
- need a clean distro reinstall
  - run `-Action Reinstall`

## Common debug tasks

## Troubleshooting playbook

Use this order before making new code changes:

1. confirm which machine the user is actually browsing
2. verify the actual distro name with `wsl -l -q`
3. inspect `.wslservarr-install.json`
4. verify the running WSL source contains the expected code
5. if UI/backend changed, redeploy with `-Action Update -DevMode`
6. call the relevant API endpoint directly
7. inspect `docker logs wslservarr_ui`
8. inspect app config files if API keys or generated settings are involved
9. only then decide whether a new code patch is needed

### 1. UI change not visible

Likely cause:

- `wslservarr_ui` was not rebuilt

Fix:

```powershell
.\wslservarr.ps1 -Action Update -DevMode
```

Then refresh the browser.

### 2. Backend logic does not match edited code

Likely cause:

- the container is still running old code
- or the user is connected to a different machine than the one being edited

Checks:

- compare local source with `/opt/wslservarr/src/wslservarr-ui/server.js` in WSL
- inspect `docker logs wslservarr_ui`
- verify the browser URL and the target machine

### 3. Distro not found errors

Symptom:

- PowerShell commands fail because they assume `wslservarr-wsl`

Fix:

- inspect `wsl -l -q`
- inspect `.wslservarr-install.json`
- pass the correct `-DistroName` if needed

### 4. Post-restart relink skips apps because API keys are missing

Recent logic was added so the backend can discover missing API keys from on-disk app config files.

Relevant config files:

- `/mnt/config/sonarr/config.xml`
- `/mnt/config/radarr/config.xml`
- `/mnt/config/prowlarr/config.xml`
- `/mnt/config/sabnzbd/sabnzbd.ini`

If relink still skips apps:

- check whether the running backend contains the API-key sync code
- redeploy the UI with `-Action Update -DevMode`
- inspect the config files for actual API keys

### 5. IPv4/LAN URLs not appearing in the UI

URL rendering is primarily in `wslservarr-ui/src/App.jsx`.

Recent behavior:

- frontend uses the current browser host if it is not loopback
- backend bootstrap also provides a detected `networkHost` fallback

If IPv4 URLs still do not appear:

- verify the remote machine is running the updated UI/backend code
- call `GET /api/bootstrap` and check for `networkHost`
- confirm the browser is connected to the expected host

### 5a. Remote-machine workflow for LAN URL issues

If the user is browsing `http://192.168.x.x/`:

1. treat that remote machine as the true execution target
2. verify the remote instance has the latest UI/backend source
3. redeploy on that machine, not just locally
4. check `GET http://<remote-host>/api/bootstrap`
5. only then re-evaluate the frontend display problem

### 6. Startup task problems

The Windows startup task is named:

- `WSLServarr Startup`

Verify:

```powershell
Get-ScheduledTask -TaskName "WSLServarr Startup"
Get-ScheduledTaskInfo -TaskName "WSLServarr Startup"
```

Manual test:

- open Task Scheduler
- locate `WSLServarr Startup`
- right-click and choose `Run`

### 7. LAN access does not work

Likely causes:

- PowerShell was not run as Administrator
- firewall rules are missing
- `portproxy` rules are stale
- WSL IP changed

Fix:

```powershell
.\wslservarr.ps1 -Action Run
```

or:

```powershell
.\wslservarr.ps1 -Action RestartAll
```

Both should be run from an elevated PowerShell session.

## App-specific notes

### Sonarr / Radarr

- root folder setup and downloader integration are handled by backend relink logic
- Prowlarr applications and indexers may also be linked automatically

### SABnzbd

- download directory normalization and category setup are handled in the backend
- host whitelist updates may require a SAB restart

### Prowlarr

- downloader integration to SABnzbd is handled in the backend
- Prowlarr application sync may be triggered after relink

### Jellyfin

- first-start wizard automation exists in the backend
- initial admin username and password can be configured

## Useful commands

### Windows side

```powershell
wsl -l -q
wsl --status
Get-Content .\.wslservarr-install.json -Raw
```

### WSL / Docker side

```powershell
wsl -d <distro> -- docker ps
wsl -d <distro> -- docker logs wslservarr_ui
wsl -d <distro> -- bash -lc "cat /opt/wslservarr/compose.yml"
wsl -d <distro> -- bash -lc "cat /opt/wslservarr/compose.apps.yml"
```

### App config inspection

```powershell
wsl -d <distro> -- bash -lc "sed -n '1,120p' /mnt/config/sonarr/config.xml"
wsl -d <distro> -- bash -lc "sed -n '1,120p' /mnt/config/radarr/config.xml"
wsl -d <distro> -- bash -lc "sed -n '1,120p' /mnt/config/prowlarr/config.xml"
wsl -d <distro> -- bash -lc "grep -n '^api_key' /mnt/config/sabnzbd/sabnzbd.ini"
```

### API smoke checks

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:5055/api/bootstrap" | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri "http://localhost:5055/api/apply" | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri "http://localhost:5055/api/test/sonarr" | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri "http://localhost:5055/api/install/apps/restart" | ConvertTo-Json -Depth 4
```

## Safe assumptions for an LLM

Usually safe:

- the project is managed primarily through `wslservarr.ps1`
- the UI must be redeployed after edits to `wslservarr-ui/`
- many reported mismatches are stale-container issues
- `server.js` contains most orchestration logic
- `App.jsx` contains most display and frontend behavior

Not safe to assume:

- the distro name is exactly `wslservarr-wsl`
- the local machine is the same machine serving the user’s browser session
- the running UI code matches the local workspace
- LAN URL issues are frontend-only; they may be caused by stale deployment

## Recommended agent workflow

When debugging a user report:

1. identify whether the issue is PowerShell, backend, frontend, or stale deployment
2. verify the actual distro name
3. verify whether the running WSL source contains the edited code
4. if UI/backend files changed, redeploy with `-Action Update -DevMode`
5. hit the relevant API endpoint directly when possible
6. only then conclude whether another code fix is needed

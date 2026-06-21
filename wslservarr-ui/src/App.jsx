import React, { useEffect, useMemo, useRef, useState } from 'react';
import appIcon from './static/WSLServarr.png';

const defaultConfig = {
  sonarr: { enabled: false, url: 'http://sonarr:8989', apiKey: '', port: '8989', tvRoot: '/media/tv', composeYaml: '' },
  radarr: { enabled: false, url: 'http://radarr:7878', apiKey: '', port: '7878', movieRoot: '/media/movies', composeYaml: '' },
  sabnzbd: { enabled: false, url: 'http://sabnzbd:8080', apiKey: '', port: '8080', tvCategory: 'tv', movieCategory: 'movies', composeYaml: '' },
  prowlarr: { enabled: false, url: 'http://prowlarr:9696', apiKey: '', port: '9696', composeYaml: '' },
  jellyfin: { enabled: false, url: 'http://jellyfin:8096', apiKey: '', port: '8096', composeYaml: '' },
  paths: { mediaRoot: '/mnt/media', downloadsRoot: '/mnt/downloads', configRoot: '/mnt/config' },
  runtime: { timezone: 'America/New_York', puid: '1000', pgid: '1000' },
  composeYaml: ''
};

function mergeConfig(input) {
  const cfg = input || {};
  return {
    ...defaultConfig,
    ...cfg,
    sonarr: { ...defaultConfig.sonarr, ...(cfg.sonarr || {}) },
    radarr: { ...defaultConfig.radarr, ...(cfg.radarr || {}) },
    sabnzbd: { ...defaultConfig.sabnzbd, ...(cfg.sabnzbd || {}) },
    prowlarr: { ...defaultConfig.prowlarr, ...(cfg.prowlarr || {}) },
    jellyfin: { ...defaultConfig.jellyfin, ...(cfg.jellyfin || {}) },
    paths: { ...defaultConfig.paths, ...(cfg.paths || {}) },
    runtime: { ...defaultConfig.runtime, ...(cfg.runtime || {}) }
  };
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

async function discoverLanIpv4() {
  if (typeof window === 'undefined') return '';
  const RTCPeerConnectionCtor = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
  if (!RTCPeerConnectionCtor) return '';

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { pc.close(); } catch {}
      resolve('');
    }, 2500);

    const found = new Set();
    const pc = new RTCPeerConnectionCtor({ iceServers: [] });

    const finish = (value) => {
      clearTimeout(timer);
      try { pc.close(); } catch {}
      resolve(value || '');
    };

    const handleCandidateText = (text) => {
      const matches = String(text || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
      for (const ip of matches) {
        if (isLoopbackHost(ip)) continue;
        if (ip.startsWith('172.18.') || ip.startsWith('172.19.') || ip.startsWith('172.20.') || ip.startsWith('172.21.') || ip.startsWith('172.22.') || ip.startsWith('172.23.') || ip.startsWith('172.24.') || ip.startsWith('172.25.') || ip.startsWith('172.26.') || ip.startsWith('172.27.') || ip.startsWith('172.28.') || ip.startsWith('172.29.') || ip.startsWith('172.30.') || ip.startsWith('172.31.')) {
          continue;
        }
        found.add(ip);
      }

      const preferred = Array.from(found).find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.')) || Array.from(found)[0] || '';
      if (preferred) finish(preferred);
    };

    pc.onicecandidate = (event) => {
      if (event?.candidate?.candidate) {
        handleCandidateText(event.candidate.candidate);
      }
    };

    pc.createDataChannel('wslservarr');
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => finish(''));
  });
}

function App() {
  const appOrder = ['sabnzbd', 'prowlarr', 'sonarr', 'radarr', 'jellyfin'];
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(defaultConfig);
  const [containers, setContainers] = useState([]);
  const [networkHost, setNetworkHost] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState({ sonarr: false, radarr: false, sabnzbd: false, prowlarr: false, jellyfin: false });
  const [configModal, setConfigModal] = useState(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [serviceYamlDraft, setServiceYamlDraft] = useState('');
  const [serviceYamlLoading, setServiceYamlLoading] = useState(false);
  const [deployState, setDeployState] = useState({ running: false, startedAt: null, finishedAt: null, success: null, error: '', logs: [] });
  const [showDeployOutput, setShowDeployOutput] = useState(false);
  const actionsMenuRef = useRef(null);
  const deployStreamInitialized = useRef(false);
  const lastDeployStartedAt = useRef(null);

  const appModalNames = ['sonarr', 'radarr', 'sabnzbd', 'prowlarr', 'jellyfin'];

  const runningCount = useMemo(() => containers.filter((c) => c.status === 'running').length, [containers]);
  const orderedContainers = useMemo(() => {
    const rank = new Map(appOrder.map((name, index) => [name, index]));
    return [...containers].sort((a, b) => {
      const ra = rank.has(a.name) ? rank.get(a.name) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.name) ? rank.get(b.name) : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return String(a.name).localeCompare(String(b.name));
    });
  }, [containers]);

  async function loadBootstrap() {
    setLoading(true);
    try {
      const res = await fetch('/api/bootstrap');
      const data = await res.json();
      const next = mergeConfig(data.config);
      setConfig(next);
      setContainers(Array.isArray(data.containers) ? data.containers : []);
      if (data.deployState) {
        setDeployState(data.deployState);
        if (data.deployState.running || (data.deployState.logs || []).length || data.deployState.error) {
          setShowDeployOutput(true);
        }
      }
      if (data.autoSetupMessage) {
        setMessage(data.autoSetupMessage);
      }
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBootstrap();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = 'WSLServarr UI';

    let link = document.querySelector("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.setAttribute('rel', 'icon');
      document.head.appendChild(link);
    }
    link.setAttribute('href', appIcon);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const detectNetworkHost = async () => {
      if (typeof window === 'undefined') return;
      const currentHost = window.location.hostname;
      if (!isLoopbackHost(currentHost)) {
        if (!cancelled) setNetworkHost(currentHost);
        return;
      }

      const detected = await discoverLanIpv4();
      if (!cancelled) setNetworkHost(detected || '');
    };

    detectNetworkHost();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!actionsMenuOpen) return undefined;

    const handlePointerDown = (event) => {
      if (!actionsMenuRef.current?.contains(event.target)) {
        setActionsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [actionsMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const pollContainers = async () => {
      if (cancelled || inFlight) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const res = await fetch('/api/containers');
        const data = await res.json();
        if (cancelled || !res.ok || !data?.ok) return;
        if (Array.isArray(data.containers)) {
          setContainers(data.containers);
        }
      } catch {
        // keep polling quietly; avoid interrupting user editing with transient status errors
      } finally {
        inFlight = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        pollContainers();
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(pollContainers, 7000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    const stream = new EventSource('/api/install/apps/stream');

    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.state) {
          setDeployState(payload.state);

          const startedAt = payload.state.startedAt || null;
          const isRunning = !!payload.state.running;

          if (!deployStreamInitialized.current) {
            deployStreamInitialized.current = true;
            lastDeployStartedAt.current = startedAt;
            return;
          }

          if (isRunning && startedAt && startedAt !== lastDeployStartedAt.current) {
            lastDeployStartedAt.current = startedAt;
            setShowDeployOutput(true);
          }
        }
      } catch {
        // ignore malformed stream data
      }
    };

    stream.onerror = () => {
      // keep browser retry behavior
    };

    return () => stream.close();
  }, []);

  useEffect(() => {
    if (!configModal || !appModalNames.includes(configModal)) {
      setServiceYamlDraft('');
      setServiceYamlLoading(false);
      return;
    }

    let cancelled = false;
    setServiceYamlLoading(true);
    setServiceYamlDraft('');

    fetch(`/api/yaml/${configModal}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (!data?.ok) throw new Error(data?.error || 'Failed to load container YAML.');
        setServiceYamlDraft(data.serviceYaml || '');
        setConfig((prev) => ({
          ...prev,
          [configModal]: {
            ...prev[configModal],
            composeYaml: data.serviceYaml || ''
          }
        }));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setServiceYamlLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [configModal]);

  function update(path, value) {
    setConfig((prev) => {
      const next = structuredClone(prev);
      const parts = path.split('.');
      let ref = next;
      for (let i = 0; i < parts.length - 1; i++) ref = ref[parts[i]];
      ref[parts[parts.length - 1]] = value;
      return next;
    });
  }

  function getAppUrl(appName) {
    if (appName === 'sonarr') return `http://localhost:${config?.sonarr?.port || 8989}`;
    if (appName === 'radarr') return `http://localhost:${config?.radarr?.port || 7878}`;
    if (appName === 'sabnzbd') return `http://localhost:${config?.sabnzbd?.port || 8080}`;
    if (appName === 'prowlarr') return `http://localhost:${config?.prowlarr?.port || 9696}`;
    if (appName === 'jellyfin') return `http://localhost:${config?.jellyfin?.port || 8096}`;
    return '';
  }

  function getNetworkAppUrl(appName) {
    const host = String(networkHost || '').trim();
    if (!host || isLoopbackHost(host)) return '';
    if (appName === 'sonarr') return `http://${host}:${config?.sonarr?.port || 8989}`;
    if (appName === 'radarr') return `http://${host}:${config?.radarr?.port || 7878}`;
    if (appName === 'sabnzbd') return `http://${host}:${config?.sabnzbd?.port || 8080}`;
    if (appName === 'prowlarr') return `http://${host}:${config?.prowlarr?.port || 9696}`;
    if (appName === 'jellyfin') return `http://${host}:${config?.jellyfin?.port || 8096}`;
    return '';
  }

  function getJellyfinSetupUrl(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    return `${base}/web/index.html#!/wizardstart`;
  }

  function renderAppUrls(appName) {
    const localhostUrl = getAppUrl(appName);
    const lanUrl = getNetworkAppUrl(appName);
    const entries = [localhostUrl];

    if (appName === 'jellyfin') {
      entries.push(getJellyfinSetupUrl(localhostUrl));
    }

    if (lanUrl && lanUrl !== localhostUrl) {
      entries.push(lanUrl);
      if (appName === 'jellyfin') {
        entries.push(getJellyfinSetupUrl(lanUrl));
      }
    }

    const uniqueEntries = entries.filter(Boolean).filter((href, index, list) => list.indexOf(href) === index);

    if (!uniqueEntries.length) return '-';

    return (
      <div className="url-stack">
        {uniqueEntries.map((href) => (
          <a key={href} href={href} target="_blank" rel="noreferrer">
            <span>{href}</span>
          </a>
        ))}
      </div>
    );
  }

  function getContainerInfo(appName) {
    return containers.find((c) => c.name === appName) || null;
  }

  function toggleShowApiKey(appName) {
    setShowApiKeys((prev) => ({ ...prev, [appName]: !prev[appName] }));
  }

  async function saveConfig() {
    setMessage('');
    setError('');

    const payload = {
      sonarrEnabled: config.sonarr.enabled,
      sonarrUrl: config.sonarr.url,
      sonarrApiKey: config.sonarr.apiKey,
      sonarrPort: config.sonarr.port,
      tvRoot: config.sonarr.tvRoot,
      radarrEnabled: config.radarr.enabled,
      radarrUrl: config.radarr.url,
      radarrApiKey: config.radarr.apiKey,
      radarrPort: config.radarr.port,
      movieRoot: config.radarr.movieRoot,
      sabnzbdEnabled: config.sabnzbd.enabled,
      sabUrl: config.sabnzbd.url,
      sabApiKey: config.sabnzbd.apiKey,
      sabPort: config.sabnzbd.port,
      tvCategory: config.sabnzbd.tvCategory,
      movieCategory: config.sabnzbd.movieCategory,
      prowlarrEnabled: config.prowlarr.enabled,
      prowlarrUrl: config.prowlarr.url,
      prowlarrApiKey: config.prowlarr.apiKey,
      prowlarrPort: config.prowlarr.port,
      jellyfinEnabled: config.jellyfin.enabled,
      jellyfinUrl: config.jellyfin.url,
      jellyfinApiKey: config.jellyfin.apiKey,
      jellyfinPort: config.jellyfin.port,
      mediaRoot: config.paths.mediaRoot,
      downloadsRoot: config.paths.downloadsRoot,
      configRoot: config.paths.configRoot,
      timezone: config.runtime.timezone,
      puid: config.runtime.puid,
      pgid: config.runtime.pgid,
      sonarrComposeYaml: config.sonarr.composeYaml || '',
      radarrComposeYaml: config.radarr.composeYaml || '',
      sabnzbdComposeYaml: config.sabnzbd.composeYaml || '',
      prowlarrComposeYaml: config.prowlarr.composeYaml || '',
      jellyfinComposeYaml: config.jellyfin.composeYaml || '',
      composeYaml: config.composeYaml
    };

    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || 'Failed to save configuration.');
        return;
      }
      const next = mergeConfig(data.config);
      setConfig(next);
      setMessage('Configuration saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveModalConfig() {
    await saveConfig();
    if (!configModal || !appModalNames.includes(configModal)) {
      return;
    }

    if (!serviceYamlDraft.trim()) {
      setError('Container Compose YAML cannot be empty.');
      return;
    }

    const res = await fetch(`/api/yaml/${configModal}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceYaml: serviceYamlDraft })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || `Failed to save YAML for ${configModal}`);
      return;
    }
    setServiceYamlDraft(data.serviceYaml || serviceYamlDraft);
    setConfig((prev) => ({
      ...prev,
      [configModal]: {
        ...prev[configModal],
        composeYaml: data.serviceYaml || serviceYamlDraft
      }
    }));
    await loadBootstrap();
    setMessage(`Configuration saved for ${configModal}.`);
  }

  async function applySettings() {
    setMessage('');
    setError('');
    const res = await fetch('/api/apply', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || 'Apply failed');
      return;
    }
    const warningText = Array.isArray(data.warnings) && data.warnings.length
      ? ` Warnings: ${data.warnings.join(' | ')}`
      : '';
    setMessage(`${data.message || 'Relinked deployed apps.'}${warningText}`);
  }

  async function containerAction(appName, action) {
    setMessage('');
    setError('');
    const res = await fetch(`/container/${appName}/${action}`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || `${action} failed for ${appName}`);
      return;
    }
    await loadBootstrap();
  }

  async function deployApp(appName) {
    setMessage('');
    setError('');
    setShowDeployOutput(true);
    const res = await fetch(`/api/install/apps/${appName}/start`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || `Deploy failed for ${appName}`);
      return;
    }
    setMessage(`${appName} deployment started.`);
  }

  async function restartApp(appName) {
    setMessage('');
    setError('');
    setShowDeployOutput(true);
    const res = await fetch(`/api/install/apps/${appName}/restart`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || `Restart failed for ${appName}`);
      return;
    }
    setMessage(`${appName} restart started.`);
  }

  async function restartAll() {
    setMessage('');
    setError('');
    setShowDeployOutput(true);
    const res = await fetch('/api/install/apps/restart', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || 'Restart all failed');
      return;
    }
    setMessage('Restart all started.');
  }

  function statusClass(status) {
    if (status === 'running') return 'pill running';
    if (status === 'missing') return 'pill missing';
    if (String(status || '').startsWith('error')) return 'pill error';
    return 'pill stopped';
  }

  function getDeployOperationLabel() {
    if (deployState.operation === 'restart') return 'Restart';
    if (deployState.operation === 'initialize') return 'First-Start Setup';
    return 'Deploy';
  }

  const deployOperationLabel = getDeployOperationLabel();

  const modalTitles = {
    paths: 'Paths & Runtime',
    sonarr: 'Sonarr',
    radarr: 'Radarr',
    sabnzbd: 'SABnzbd',
    prowlarr: 'Prowlarr',
    jellyfin: 'Jellyfin'
  };

  function renderConfigModal() {
    const app = configModal;
    if (!app) return null;

    if (app === 'paths') {
      return (
        <>
          <label>Media Root</label><input value={config.paths.mediaRoot} onChange={(e) => update('paths.mediaRoot', e.target.value)} />
          <label>Downloads Root</label><input value={config.paths.downloadsRoot} onChange={(e) => update('paths.downloadsRoot', e.target.value)} />
          <label>Config Root</label><input value={config.paths.configRoot || ''} onChange={(e) => update('paths.configRoot', e.target.value)} />
          <label>Timezone</label><input value={config.runtime.timezone} onChange={(e) => update('runtime.timezone', e.target.value)} />
          <label>PUID</label><input value={config.runtime.puid} onChange={(e) => update('runtime.puid', e.target.value)} />
          <label>PGID</label><input value={config.runtime.pgid} onChange={(e) => update('runtime.pgid', e.target.value)} />
        </>
      );
    }

    const appConfig = config[app];
    if (!appConfig) return null;

    return (
      <>
        <label className="check"><input type="checkbox" checked={!!appConfig.enabled} onChange={(e) => update(`${app}.enabled`, e.target.checked)} /> Enabled</label>
        <label>API Key ({appConfig.apiKey ? 'set' : 'not set'})</label>
        <div className="row wrap">
          <input type={showApiKeys[app] ? 'text' : 'password'} value={appConfig.apiKey || ''} onChange={(e) => update(`${app}.apiKey`, e.target.value)} />
          <button type="button" className="secondary" onClick={() => toggleShowApiKey(app)}>{showApiKeys[app] ? 'Hide' : 'Show'}</button>
        </div>

        {app === 'sonarr' ? <><label>TV Root</label><input value={appConfig.tvRoot || ''} onChange={(e) => update('sonarr.tvRoot', e.target.value)} /></> : null}
        {app === 'radarr' ? <><label>Movie Root</label><input value={appConfig.movieRoot || ''} onChange={(e) => update('radarr.movieRoot', e.target.value)} /></> : null}
        {app === 'sabnzbd' ? <>
          <label>TV Category</label><input value={appConfig.tvCategory || ''} onChange={(e) => update('sabnzbd.tvCategory', e.target.value)} />
          <label>Movie Category</label><input value={appConfig.movieCategory || ''} onChange={(e) => update('sabnzbd.movieCategory', e.target.value)} />
        </> : null}
        {app === 'prowlarr' ? <p className="hint" style={{ marginTop: 8 }}>Sonarr/Radarr indexers are managed through Prowlarr only.</p> : null}
        <p className="hint" style={{ marginTop: 8 }}>This app deploys from its own YAML only. Changes here affect this app when you click Start (if missing), Deploy, or RestartAll.</p>

        <label style={{ marginTop: 16 }}>Container Compose YAML</label>
        <textarea className="codebox" value={serviceYamlDraft} onChange={(e) => setServiceYamlDraft(e.target.value)} placeholder={serviceYamlLoading ? 'Loading container YAML...' : ''} disabled={serviceYamlLoading} />
      </>
    );
  }

  if (loading) {
    return (
      <div className="page">
        <div className="app-brand">
          <img src={appIcon} alt="WSLServarr" className="app-logo" />
          <h1>WSLServarr</h1>
        </div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <div className="app-brand">
            <img src={appIcon} alt="WSLServarr" className="app-logo" />
            <h1>WSLServarr</h1>
          </div>
          <p className="subtitle">Simple media stack control panel</p>
        </div>
        <div className="row">
          <button className="secondary" onClick={loadBootstrap}>Refresh</button>
        </div>
      </header>

      {message ? <div className="msg ok">{message}</div> : null}
      {error ? <div className="msg err">{error}</div> : null}

      <section className="card stats">
        <div><span>Services</span><strong>{containers.length}</strong></div>
        <div><span>Running</span><strong>{runningCount}</strong></div>
      </section>

      <section className="card">
        <div className="row wrap runtime-toolbar" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Runtime</h2>
          <div className="toolbar-menu" ref={actionsMenuRef}>
            <button
              className="secondary icon-button"
              type="button"
              aria-label="Open actions menu"
              aria-haspopup="menu"
              aria-expanded={actionsMenuOpen}
              onClick={() => setActionsMenuOpen((prev) => !prev)}
            >
              ⚙
            </button>
            {actionsMenuOpen ? (
              <div className="menu-dropdown" role="menu">
                <button type="button" className="menu-item" onClick={() => { setActionsMenuOpen(false); setConfigModal('paths'); }}>Paths & Runtime</button>
                <button type="button" className="menu-item" onClick={() => { setActionsMenuOpen(false); applySettings(); }}>Relink Deployed Apps</button>
                <button type="button" className="menu-item" onClick={() => { setActionsMenuOpen(false); restartAll(); }}>Restart All</button>
                <button type="button" className="menu-item" onClick={() => { setActionsMenuOpen(false); saveConfig(); }} disabled={saving}>{saving ? 'Saving...' : 'Save All'}</button>
              </div>
            ) : null}
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Service</th><th>Status</th><th>URL</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {orderedContainers.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td><span className={statusClass(c.status)}>{c.status}</span></td>
                <td>{renderAppUrls(c.name)}</td>
                <td>
                  <div className="row wrap">
                    <button type="button" className="secondary" onClick={() => containerAction(c.name, c.status === 'running' ? 'stop' : 'start')}>
                      {c.status === 'running' ? 'Stop' : 'Start'}
                    </button>
                    <button type="button" className="secondary" onClick={() => restartApp(c.name)}>Restart</button>
                    {c.status === 'missing' ? <button type="button" onClick={() => deployApp(c.name)}>Deploy</button> : null}
                    <button type="button" className="secondary" onClick={() => setConfigModal(c.name)}>Configure</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {showDeployOutput && (deployState.running || deployState.logs.length || deployState.error) ? (
        <div className="modal-backdrop" onClick={() => setShowDeployOutput(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>{deployOperationLabel} Output</h3>
                <p className="hint" style={{ marginTop: 6 }}>
                  {deployState.running
                    ? `${deployOperationLabel} in progress...`
                    : deployState.success === true
                      ? `Last ${deployOperationLabel.toLowerCase()} completed successfully.`
                      : deployState.success === false
                        ? `Last ${deployOperationLabel.toLowerCase()} failed.`
                        : `${deployOperationLabel} log.`}
                </p>
              </div>
              <button type="button" className="secondary modal-close" onClick={() => setShowDeployOutput(false)}>✕</button>
            </div>
            <div className="modal-body">
              <pre className="terminal-output">{(deployState.logs || []).join('\n') || 'No deploy output yet.'}</pre>
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setShowDeployOutput(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

      {configModal ? (
        <div className="modal-backdrop" onClick={() => setConfigModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{modalTitles[configModal] || 'Configuration'}</h3>
              <button type="button" className="secondary modal-close" onClick={() => setConfigModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {renderConfigModal()}
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setConfigModal(null)}>Close</button>
              <button type="button" className="secondary" onClick={applySettings}>Relink Deployed Apps</button>
              <button type="button" onClick={saveModalConfig} disabled={saving || serviceYamlLoading}>{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;

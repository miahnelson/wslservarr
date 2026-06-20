import React, { useEffect, useMemo, useState } from 'react';

const defaultConfig = {
  sonarr: { enabled: false, url: 'http://sonarr:8989', apiKey: '', port: '8989', tvRoot: '/media/tv', composeYaml: '' },
  radarr: { enabled: false, url: 'http://radarr:7878', apiKey: '', port: '7878', movieRoot: '/media/movies', composeYaml: '' },
  sabnzbd: { enabled: false, url: 'http://sabnzbd:8080', apiKey: '', port: '8080', tvCategory: 'tv', movieCategory: 'movies', composeYaml: '' },
  prowlarr: { enabled: false, url: 'http://prowlarr:9696', apiKey: '', port: '9696', composeYaml: '' },
  jellyfin: { enabled: false, url: 'http://jellyfin:8096', apiKey: '', port: '8096', composeYaml: '' },
  newshosting: { enabled: false, name: 'newshosting', host: 'news.newshosting.com', port: 563, username: '', password: '', ssl: true, connections: 40, retention: 0, optional: false },
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
    newshosting: { ...defaultConfig.newshosting, ...(cfg.newshosting || {}) },
    paths: { ...defaultConfig.paths, ...(cfg.paths || {}) },
    runtime: { ...defaultConfig.runtime, ...(cfg.runtime || {}) }
  };
}

function App() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(defaultConfig);
  const [containers, setContainers] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState({ sonarr: false, radarr: false, sabnzbd: false, prowlarr: false, jellyfin: false });
  const [configModal, setConfigModal] = useState(null);
  const [serviceYamlDraft, setServiceYamlDraft] = useState('');
  const [serviceYamlLoading, setServiceYamlLoading] = useState(false);
  const [deployState, setDeployState] = useState({ running: false, startedAt: null, finishedAt: null, success: null, error: '', logs: [] });
  const [showDeployOutput, setShowDeployOutput] = useState(false);

  const appModalNames = ['sonarr', 'radarr', 'sabnzbd', 'prowlarr', 'jellyfin'];

  const runningCount = useMemo(() => containers.filter((c) => c.status === 'running').length, [containers]);

  async function loadBootstrap() {
    setLoading(true);
    try {
      const res = await fetch('/api/bootstrap');
      const data = await res.json();
      const next = mergeConfig(data.config);
      setConfig(next);
      setContainers(Array.isArray(data.containers) ? data.containers : []);
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
    const stream = new EventSource('/api/install/apps/stream');

    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.state) {
          setDeployState(payload.state);
          if (payload.state.running || (Array.isArray(payload.state.logs) && payload.state.logs.length)) {
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
      newshostingEnabled: config.newshosting.enabled,
      newshostingName: config.newshosting.name,
      newshostingHost: config.newshosting.host,
      newshostingPort: config.newshosting.port,
      newshostingUsername: config.newshosting.username,
      newshostingPassword: config.newshosting.password,
      newshostingSsl: config.newshosting.ssl,
      newshostingConnections: config.newshosting.connections,
      newshostingRetention: config.newshosting.retention,
      newshostingOptional: config.newshosting.optional,
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
    setMessage(data.message || 'Applied');
  }

  async function discoverApiKeys() {
    setMessage('');
    setError('');
    const res = await fetch('/api/discover-keys', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || 'API key discovery failed');
      return;
    }
    const next = mergeConfig(data.config || config);
    setConfig(next);
    setMessage(data.message || 'API key discovery completed.');
  }

  async function testConnection(appName) {
    setMessage('');
    setError('');
    const res = await fetch(`/api/test/${appName}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || `${appName} test failed`);
      return;
    }
    setMessage(data.message || `${appName} OK`);
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

  async function deployAll() {
    setMessage('');
    setError('');
    setShowDeployOutput(true);
    const res = await fetch('/api/install/apps/start', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || 'Deploy failed');
      return;
    }
    setMessage('Deployment started.');
  }

  function statusClass(status) {
    if (status === 'running') return 'pill running';
    if (status === 'missing') return 'pill missing';
    if (String(status || '').startsWith('error')) return 'pill error';
    return 'pill stopped';
  }

  const modalTitles = {
    paths: 'Paths & Runtime',
    newshosting: 'Newshosting Server',
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

    if (app === 'newshosting') {
      return (
        <>
          <label className="check"><input type="checkbox" checked={!!config.newshosting.enabled} onChange={(e) => update('newshosting.enabled', e.target.checked)} /> Enabled</label>
          <label>Name</label><input value={config.newshosting.name} onChange={(e) => update('newshosting.name', e.target.value)} />
          <label>Host</label><input value={config.newshosting.host} onChange={(e) => update('newshosting.host', e.target.value)} />
          <label>Port</label><input value={config.newshosting.port} onChange={(e) => update('newshosting.port', e.target.value)} />
          <label>Username</label><input value={config.newshosting.username} onChange={(e) => update('newshosting.username', e.target.value)} />
          <label>Password</label><input type="password" value={config.newshosting.password} onChange={(e) => update('newshosting.password', e.target.value)} />
          <label className="check"><input type="checkbox" checked={!!config.newshosting.ssl} onChange={(e) => update('newshosting.ssl', e.target.checked)} /> SSL</label>
          <label className="check"><input type="checkbox" checked={!!config.newshosting.optional} onChange={(e) => update('newshosting.optional', e.target.checked)} /> Optional</label>
          <label>Connections</label><input value={config.newshosting.connections} onChange={(e) => update('newshosting.connections', e.target.value)} />
          <label>Retention</label><input value={config.newshosting.retention} onChange={(e) => update('newshosting.retention', e.target.value)} />
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
        <p className="hint" style={{ marginTop: 8 }}>This app deploys from its own YAML only. Changes here affect this app when you click Deploy or RestartAll.</p>

        <label style={{ marginTop: 16 }}>Container Compose YAML</label>
        <textarea className="codebox" value={serviceYamlDraft} onChange={(e) => setServiceYamlDraft(e.target.value)} placeholder={serviceYamlLoading ? 'Loading container YAML...' : ''} disabled={serviceYamlLoading} />
      </>
    );
  }

  if (loading) return <div className="page"><h1>WSLServarr</h1><p>Loading...</p></div>;

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>WSLServarr</h1>
          <p className="subtitle">Simple media stack control panel</p>
        </div>
        <div className="row">
          <button className="secondary" onClick={loadBootstrap}>Refresh</button>
          <button onClick={deployAll}>Deploy Enabled</button>
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
          <div className="row wrap">
            <button className="secondary" type="button" onClick={() => setConfigModal('paths')}>Paths & Runtime</button>
            <button className="secondary" type="button" onClick={() => setConfigModal('newshosting')}>Newshosting</button>
            <button className="secondary" type="button" onClick={discoverApiKeys}>Auto-Fill API Keys</button>
            <button className="secondary" type="button" onClick={applySettings}>Apply to Apps</button>
            <button type="button" onClick={saveConfig} disabled={saving}>{saving ? 'Saving...' : 'Save All'}</button>
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Service</th><th>Status</th><th>URL</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {containers.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td><span className={statusClass(c.status)}>{c.status}</span></td>
                <td>{getAppUrl(c.name) ? <a href={getAppUrl(c.name)} target="_blank" rel="noreferrer">{getAppUrl(c.name)}</a> : '-'}</td>
                <td>
                  <div className="row wrap">
                    <button type="button" className="secondary" onClick={() => containerAction(c.name, 'start')}>Start</button>
                    <button type="button" className="secondary" onClick={() => containerAction(c.name, 'stop')}>Stop</button>
                    <button type="button" className="secondary" onClick={() => containerAction(c.name, 'restart')}>Restart</button>
                    <button type="button" className="secondary" onClick={() => testConnection(c.name)}>Test</button>
                    <button type="button" onClick={() => deployApp(c.name)}>Deploy</button>
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
                <h3>Deploy Output</h3>
                <p className="hint" style={{ marginTop: 6 }}>
                  {deployState.running
                    ? 'Deployment in progress...'
                    : deployState.success === true
                      ? 'Last deployment completed successfully.'
                      : deployState.success === false
                        ? 'Last deployment failed.'
                        : 'Deployment log.'}
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
              <button type="button" className="secondary" onClick={applySettings}>Apply to Apps</button>
              <button type="button" onClick={saveModalConfig} disabled={saving || serviceYamlLoading}>{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;

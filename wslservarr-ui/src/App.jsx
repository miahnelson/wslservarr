import React, { useEffect, useMemo, useState } from 'react';

const defaultConfig = {
  sonarr: { enabled: false, url: 'http://sonarr:8989', apiKey: '', port: '8989', tvRoot: '/media/tv' },
  radarr: { enabled: false, url: 'http://radarr:7878', apiKey: '', port: '7878', movieRoot: '/media/movies' },
  sabnzbd: { enabled: false, url: 'http://sabnzbd:8080', apiKey: '', port: '8080', tvCategory: 'tv', movieCategory: 'movies' },
  jellyfin: { enabled: false, url: 'http://jellyfin:8096', apiKey: '', port: '8096' },
  newshosting: { enabled: false, name: 'newshosting', host: 'news.newshosting.com', port: 563, username: '', password: '', ssl: true, connections: 40, retention: 0, optional: false },
  indexers: [],
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
    jellyfin: { ...defaultConfig.jellyfin, ...(cfg.jellyfin || {}) },
    newshosting: { ...defaultConfig.newshosting, ...(cfg.newshosting || {}) },
    paths: { ...defaultConfig.paths, ...(cfg.paths || {}) },
    runtime: { ...defaultConfig.runtime, ...(cfg.runtime || {}) },
    indexers: Array.isArray(cfg.indexers) ? cfg.indexers : []
  };
}

function App() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(defaultConfig);
  const [containers, setContainers] = useState([]);
  const [indexersJson, setIndexersJson] = useState('[]');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const runningCount = useMemo(() => containers.filter((c) => c.status === 'running').length, [containers]);

  async function loadBootstrap() {
    setLoading(true);
    try {
      const res = await fetch('/api/bootstrap');
      const data = await res.json();
      const next = mergeConfig(data.config);
      setConfig(next);
      setIndexersJson(JSON.stringify(next.indexers || [], null, 2));
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
    if (appName === 'jellyfin') return `http://localhost:${config?.jellyfin?.port || 8096}`;
    return '';
  }

  async function saveConfig() {
    setMessage('');
    setError('');

    let parsedIndexers = [];
    try {
      parsedIndexers = JSON.parse(indexersJson || '[]');
      if (!Array.isArray(parsedIndexers)) throw new Error('Indexers must be a JSON array');
    } catch (e) {
      setError(`Invalid indexers JSON: ${e.message}`);
      return;
    }

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
      indexers: parsedIndexers,
      mediaRoot: config.paths.mediaRoot,
      downloadsRoot: config.paths.downloadsRoot,
      configRoot: config.paths.configRoot,
      timezone: config.runtime.timezone,
      puid: config.runtime.puid,
      pgid: config.runtime.pgid,
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
      setIndexersJson(JSON.stringify(next.indexers || [], null, 2));
      setMessage('Configuration saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
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
        <h2>Runtime</h2>
        <table>
          <thead>
            <tr><th>Service</th><th>Status</th><th>Image</th><th>URL</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {containers.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td><span className={statusClass(c.status)}>{c.status}</span></td>
                <td>{c.image || '-'}</td>
                <td>{getAppUrl(c.name) ? <a href={getAppUrl(c.name)} target="_blank" rel="noreferrer">{getAppUrl(c.name)}</a> : '-'}</td>
                <td>
                  <div className="row wrap">
                    <button className="secondary" onClick={() => containerAction(c.name, 'start')}>Start</button>
                    <button className="secondary" onClick={() => containerAction(c.name, 'stop')}>Stop</button>
                    <button className="secondary" onClick={() => containerAction(c.name, 'restart')}>Restart</button>
                    <button className="secondary" onClick={() => testConnection(c.name)}>Test</button>
                    <button onClick={() => deployApp(c.name)}>Deploy</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Settings</h2>

        <div className="grid two">
          <div>
            <h3>Paths & Runtime</h3>
            <label>Media Root</label><input value={config.paths.mediaRoot} onChange={(e) => update('paths.mediaRoot', e.target.value)} />
            <label>Downloads Root</label><input value={config.paths.downloadsRoot} onChange={(e) => update('paths.downloadsRoot', e.target.value)} />
            <label>Timezone</label><input value={config.runtime.timezone} onChange={(e) => update('runtime.timezone', e.target.value)} />
            <label>PUID</label><input value={config.runtime.puid} onChange={(e) => update('runtime.puid', e.target.value)} />
            <label>PGID</label><input value={config.runtime.pgid} onChange={(e) => update('runtime.pgid', e.target.value)} />
          </div>

          <div>
            <h3>App Endpoints</h3>
            <label>Sonarr URL</label><input value={config.sonarr.url} onChange={(e) => update('sonarr.url', e.target.value)} />
            <label>Sonarr API Key</label><input type="password" value={config.sonarr.apiKey} onChange={(e) => update('sonarr.apiKey', e.target.value)} />
            <label>Radarr URL</label><input value={config.radarr.url} onChange={(e) => update('radarr.url', e.target.value)} />
            <label>Radarr API Key</label><input type="password" value={config.radarr.apiKey} onChange={(e) => update('radarr.apiKey', e.target.value)} />
            <label>SABnzbd URL</label><input value={config.sabnzbd.url} onChange={(e) => update('sabnzbd.url', e.target.value)} />
            <label>SABnzbd API Key</label><input type="password" value={config.sabnzbd.apiKey} onChange={(e) => update('sabnzbd.apiKey', e.target.value)} />
            <label>Jellyfin URL</label><input value={config.jellyfin.url} onChange={(e) => update('jellyfin.url', e.target.value)} />
          </div>
        </div>

        <div className="grid two">
          <div>
            <h3>Newshosting (to SAB)</h3>
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
          </div>

          <div>
            <h3>Indexers (to Sonarr/Radarr)</h3>
            <p className="hint">JSON array format.</p>
            <textarea className="codebox" value={indexersJson} onChange={(e) => setIndexersJson(e.target.value)} />
          </div>
        </div>

        <div className="row">
          <button onClick={saveConfig} disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</button>
          <button className="secondary" onClick={applySettings}>Apply to Apps</button>
        </div>
      </section>
    </div>
  );
}

export default App;

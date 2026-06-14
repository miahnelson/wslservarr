import React, { useEffect, useMemo, useState } from 'react';

const defaultConfig = {
  sonarr: { enabled: false, url: 'http://sonarr:8989', apiKey: '', port: '8989', tvRoot: '/mnt/media/tv' },
  radarr: { enabled: false, url: 'http://radarr:7878', apiKey: '', port: '7878', movieRoot: '/mnt/media/movies' },
  sabnzbd: { enabled: false, url: 'http://sabnzbd:8080', apiKey: '', port: '8080', tvCategory: 'tv', movieCategory: 'movies' },
  paths: { mediaRoot: '/mnt/media', downloadsRoot: '/mnt/downloads', configRoot: '/mnt/config' },
  runtime: { timezone: 'America/New_York', puid: '1000', pgid: '1000' },
  composeYaml: ''
};

function App() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(defaultConfig);
  const [containers, setContainers] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deployState, setDeployState] = useState({ running: false, logs: [] });
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlAppName, setYamlAppName] = useState('');
  const [yamlText, setYamlText] = useState('');
  const [yamlSaving, setYamlSaving] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagTitle, setDiagTitle] = useState('');
  const [diagText, setDiagText] = useState('');
  const [diagPath, setDiagPath] = useState('');

  const runningCount = useMemo(() => containers.filter(c => c.status === 'running').length, [containers]);
  const missingCount = useMemo(() => containers.filter(c => c.status === 'missing').length, [containers]);

  async function loadBootstrap() {
    setLoading(true);
    try {
      const res = await fetch('/api/bootstrap');
      const data = await res.json();
      setConfig(data.config || defaultConfig);
      setContainers(data.containers || []);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBootstrap();

    const stream = new EventSource('/api/install/apps/stream');
    stream.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data || '{}');
        if (payload.state) setDeployState(payload.state);
      } catch {
        // noop
      }
    };
    return () => stream.close();
  }, []);

  const deployLog = useMemo(() => (deployState.logs || []).join('\n') || 'No deployment output yet.', [deployState]);

  function getAppUrl(appName) {
    if (appName === 'sonarr') return `http://localhost:${config?.sonarr?.port || 8989}`;
    if (appName === 'radarr') return `http://localhost:${config?.radarr?.port || 7878}`;
    if (appName === 'sabnzbd') return `http://localhost:${config?.sabnzbd?.port || 8080}`;
    return '';
  }

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
      mediaRoot: config.paths.mediaRoot,
      downloadsRoot: config.paths.downloadsRoot,
      configRoot: config.paths.configRoot,
      timezone: config.runtime.timezone,
      puid: config.runtime.puid,
      pgid: config.runtime.pgid,
      composeYaml: config.composeYaml
    };
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
    setConfig(data.config);
    setMessage('Configuration saved.');
  }

  async function testConnection(appName) {
    const res = await fetch(`/api/test/${appName}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || `${appName} test failed`);
      return;
    }
    setMessage(data.message || `${appName} OK`);
  }

  async function containerAction(appName, action) {
    const res = await fetch(`/container/${appName}/${action}`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || `${action} failed for ${appName}`);
      return;
    }
    await loadBootstrap();
  }

  async function applySettings() {
    const res = await fetch('/api/apply', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || 'Apply failed');
      return;
    }
    setMessage(data.message || 'Applied settings');
  }

  async function startDeployForApp(appName) {
    setMessage('');
    setError('');
    setDeployModalOpen(true);
    if (deployState.running) {
      setMessage('Deployment already running. Showing live output.');
      return;
    }

    try {
      const res = await fetch(`/api/install/apps/${appName}/start`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || `Failed to start ${appName} deployment`);
        return;
      }
      setDeployState(data.state);
      setMessage(`${appName} deployment started.`);
    } catch (e) {
      setError(`Failed to start ${appName} deployment: ${e.message}`);
      return;
    }
  }

  async function saveCompose() {
    const res = await fetch('/api/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ composeYaml: config.composeYaml })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || 'Failed to save compose YAML');
      return;
    }
    setMessage('Compose YAML saved.');
  }

  async function openYamlEditor(appName) {
    setError('');
    setYamlAppName(appName);
    setYamlText('Loading...');
    setYamlOpen(true);
    const res = await fetch(`/api/yaml/${appName}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setYamlText('');
      setError(data.error || `Failed to load ${appName} yaml`);
      return;
    }
    setYamlText(data.serviceYaml || `  ${appName}:\n    image: lscr.io/linuxserver/${appName}:latest`);
  }

  async function saveYamlEditor() {
    if (!yamlAppName) return;
    setYamlSaving(true);
    setError('');
    const res = await fetch(`/api/yaml/${yamlAppName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceYaml: yamlText })
    });
    const data = await res.json();
    setYamlSaving(false);
    if (!res.ok || !data.ok) {
      setError(data.error || `Failed to save ${yamlAppName} yaml`);
      return;
    }
    setYamlText(data.serviceYaml || yamlText);
    setMessage(`${yamlAppName} yaml saved.`);
  }

  async function captureDiagnostics(appName) {
    setError('');
    setDiagTitle(`${appName} diagnostics`);
    setDiagText('Capturing diagnostics...');
    setDiagPath('');
    setDiagOpen(true);
    try {
      const res = await fetch(`/api/diagnostics/${appName}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setDiagText(data.error || 'Failed to capture diagnostics');
        return;
      }
      setDiagText(data.content || '(empty diagnostics)');
      setDiagPath(data.filePath || '');
      setMessage(`${appName} diagnostics captured.`);
    } catch (e) {
      setDiagText(`Failed to capture diagnostics: ${e.message}`);
    }
  }

  if (loading) return <div className="container"><h1>❯ wslservarr</h1><p>Loading…</p></div>;

  const deployStatus = deployState.running ? 'running' : deployState.success === false ? 'failed' : deployState.success === true ? 'completed' : 'idle';

  function statusClass(status) {
    if (status === 'running') return 'status-pill running';
    if (status === 'missing') return 'status-pill missing';
    if (String(status || '').startsWith('error')) return 'status-pill error';
    return 'status-pill stopped';
  }

  return (
    <div className="container">
      <h1>❯ wslservarr</h1>
      <p className="subtitle">distributed media orchestration platform (React)</p>

      {message ? <div className="msg ok">✓ {message}</div> : null}
      {error ? <div className="msg err">⚠ {error}</div> : null}

      <div className="runtime-stats">
        <div className="stat-card"><span>services</span><strong>{containers.length}</strong></div>
        <div className="stat-card"><span>running</span><strong>{runningCount}</strong></div>
        <div className="stat-card"><span>missing</span><strong>{missingCount}</strong></div>
        <div className="stat-card"><span>deploy</span><strong className={`deploy-${deployStatus}`}>{deployStatus}</strong></div>
      </div>

      <div className="card">
        <div className="inline-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>⚙ Container Runtime</h2>
          <div className="inline-row">
            <button className="secondary" onClick={() => setDeployModalOpen(true)}>view output</button>
            <button className="secondary" onClick={() => setSettingsOpen(true)} title="Settings">⚙ settings</button>
          </div>
        </div>
        <table className="runtime-table">
          <thead><tr><th>Service</th><th>Status</th><th>Image</th><th>URL</th><th>Controls</th></tr></thead>
          <tbody>
            {containers.map((c) => (
              <tr key={c.name}>
                <td><strong className="service-name">{c.name}</strong></td>
                <td><span className={statusClass(c.status)}>{c.status}</span></td>
                <td>{c.image || '-'}</td>
                <td>
                  {c.status === 'running' ? (
                    <a className="service-url" href={getAppUrl(c.name)} target="_blank" rel="noreferrer">{getAppUrl(c.name)}</a>
                  ) : (
                    '-'
                  )}
                </td>
                <td>
                  <div className="action-grid">
                    <button className="secondary action-btn" onClick={() => containerAction(c.name, 'start')}>start</button>
                    <button className="secondary action-btn" onClick={() => containerAction(c.name, 'stop')}>stop</button>
                    <button className="secondary action-btn" onClick={() => containerAction(c.name, 'restart')}>restart</button>
                    <button className="secondary action-btn accent" onClick={() => startDeployForApp(c.name)}>deploy</button>
                    <button className="secondary action-btn" onClick={() => testConnection(c.name)}>test</button>
                    <button className="secondary action-btn" onClick={() => openYamlEditor(c.name)}>yaml</button>
                    <button className="secondary action-btn" onClick={() => captureDiagnostics(c.name)}>diag</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deployModalOpen ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="inline-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>Deployment Output</h3>
              <button className="secondary" onClick={() => setDeployModalOpen(false)}>close</button>
            </div>
            <p className="small">status: {deployState.running ? 'running' : deployState.success === false ? 'failed' : deployState.success === true ? 'completed' : 'idle'}</p>
            <pre style={{ maxHeight: 420, overflow: 'auto' }}>{deployLog}</pre>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="modal-backdrop">
          <div className="modal-card modal-large">
            <div className="inline-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>Settings</h3>
              <button className="secondary" onClick={() => setSettingsOpen(false)}>close</button>
            </div>

            <div className="grid-2">
              <div>
                <label>Media Root</label><input value={config.paths.mediaRoot} onChange={(e) => update('paths.mediaRoot', e.target.value)} />
                <label>Downloads Root</label><input value={config.paths.downloadsRoot} onChange={(e) => update('paths.downloadsRoot', e.target.value)} />
                <label>Config Root</label><input value={config.paths.configRoot || ''} onChange={(e) => update('paths.configRoot', e.target.value)} />
                <label>Timezone</label><input value={config.runtime.timezone} onChange={(e) => update('runtime.timezone', e.target.value)} />
              </div>
              <div>
                <label>PUID</label><input value={config.runtime.puid} onChange={(e) => update('runtime.puid', e.target.value)} />
                <label>PGID</label><input value={config.runtime.pgid} onChange={(e) => update('runtime.pgid', e.target.value)} />
                <label>Sonarr URL</label><input value={config.sonarr.url} onChange={(e) => update('sonarr.url', e.target.value)} />
                <label>Radarr URL</label><input value={config.radarr.url} onChange={(e) => update('radarr.url', e.target.value)} />
                <label>SAB URL</label><input value={config.sabnzbd.url} onChange={(e) => update('sabnzbd.url', e.target.value)} />
              </div>
            </div>

            <label>Full Compose YAML</label>
            <textarea className="codebox" value={config.composeYaml || ''} onChange={(e) => update('composeYaml', e.target.value)} />

            <div className="inline-row">
              <button onClick={saveConfig}>💾 save settings</button>
              <button className="secondary" onClick={saveCompose}>💾 save compose yaml</button>
              <button className="success" onClick={applySettings}>✓ apply config</button>
            </div>
          </div>
        </div>
      ) : null}

      {yamlOpen ? (
        <div className="modal-backdrop">
          <div className="modal-card modal-large">
            <div className="inline-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{yamlAppName} YAML</h3>
              <button className="secondary" onClick={() => setYamlOpen(false)}>close</button>
            </div>
            <textarea className="codebox" value={yamlText} onChange={(e) => setYamlText(e.target.value)} />
            <div className="inline-row">
              <button onClick={saveYamlEditor} disabled={yamlSaving}>{yamlSaving ? 'saving...' : '💾 save yaml'}</button>
              <button className="secondary" onClick={() => setYamlOpen(false)}>done</button>
            </div>
          </div>
        </div>
      ) : null}

      {diagOpen ? (
        <div className="modal-backdrop">
          <div className="modal-card modal-large">
            <div className="inline-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{diagTitle}</h3>
              <button className="secondary" onClick={() => setDiagOpen(false)}>close</button>
            </div>
            {diagPath ? <p className="small">saved: {diagPath}</p> : null}
            <textarea className="codebox" value={diagText} readOnly />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;

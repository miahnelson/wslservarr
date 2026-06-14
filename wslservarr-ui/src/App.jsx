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
  const [firstRun, setFirstRun] = useState(false);
  const [forceWizard, setForceWizard] = useState(false);
  const [config, setConfig] = useState(defaultConfig);
  const [containers, setContainers] = useState([]);
  const [checks, setChecks] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deployState, setDeployState] = useState({ running: false, logs: [] });
  const [wizardInstallNow, setWizardInstallNow] = useState(true);
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlAppName, setYamlAppName] = useState('');
  const [yamlText, setYamlText] = useState('');
  const [yamlSaving, setYamlSaving] = useState(false);

  const wizardMode = firstRun || forceWizard;

  async function loadBootstrap(force = false) {
    setLoading(true);
    try {
      const res = await fetch(`/api/bootstrap${force ? '?forceWizard=1' : ''}`);
      const data = await res.json();
      setConfig(data.config || defaultConfig);
      setContainers(data.containers || []);
      setChecks(data.checks || {});
      setFirstRun(Boolean(data.firstRun));
      setForceWizard(Boolean(data.forceWizard));
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const qp = new URLSearchParams(window.location.search);
    const force = qp.get('force') === '1';
    loadBootstrap(force);

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
    await loadBootstrap(false);
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

  async function startDeploy() {
    setMessage('');
    setError('');
    setDeployModalOpen(true);
    const res = await fetch('/api/install/apps/start', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || 'Failed to start deployment');
      return;
    }
    setDeployState(data.state);
  }

  async function startDeployForApp(appName) {
    setMessage('');
    setError('');
    setDeployModalOpen(true);
    const res = await fetch(`/api/install/apps/${appName}/start`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || `Failed to start ${appName} deployment`);
      return;
    }
    setDeployState(data.state);
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

  async function completeWizard() {
    setMessage('');
    setError('');
    const payload = {
      sonarrEnabled: config.sonarr.enabled,
      sonarrPort: config.sonarr.port,
      sonarrMediaPath: config.sonarr.tvRoot,
      radarrEnabled: config.radarr.enabled,
      radarrPort: config.radarr.port,
      radarrMediaPath: config.radarr.movieRoot,
      sabnzbdEnabled: config.sabnzbd.enabled,
      sabnzbdPort: config.sabnzbd.port,
      tvCategory: config.sabnzbd.tvCategory,
      movieCategory: config.sabnzbd.movieCategory,
      mediaRoot: config.paths.mediaRoot,
      downloadsRoot: config.paths.downloadsRoot,
      configRoot: config.paths.configRoot,
      timezone: config.runtime.timezone,
      puid: config.runtime.puid,
      pgid: config.runtime.pgid,
      installNow: wizardInstallNow,
      composeYaml: config.composeYaml,
      forceMode: forceWizard
    };

    const validateRes = await fetch('/api/wizard/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const validation = await validateRes.json();
    if (!validation.ok) {
      setError((validation.errors || ['Validation failed']).join(' '));
      return;
    }

    const res = await fetch(forceWizard ? '/api/wizard/complete?force=1' : '/api/wizard/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || 'Wizard completion failed');
      return;
    }

    setMessage(data.installed ? 'Wizard completed and apps installed.' : 'Wizard completed.');
    setFirstRun(false);
    setForceWizard(false);
    await loadBootstrap(false);
  }

  async function restartWizard() {
    const res = await fetch('/api/wizard/restart', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error || 'Failed to restart wizard');
      return;
    }
    setForceWizard(true);
    setMessage('Wizard restarted.');
  }

  if (loading) return <div className="container"><h1>❯ wslservarr</h1><p>Loading…</p></div>;

  return (
    <div className="container">
      <h1>❯ wslservarr</h1>
      <p className="subtitle">{wizardMode ? 'Initial setup wizard (React)' : 'distributed media orchestration platform (React)'}</p>

      {message ? <div className="msg ok">✓ {message}</div> : null}
      {error ? <div className="msg err">⚠ {error}</div> : null}

      {wizardMode ? (
        <div className="card">
          <h2>Setup Wizard</h2>
          <p className="card-subtitle">Configure apps, storage and runtime. This is the initial wizard flow.</p>

          <div className="inline-row" style={{ marginBottom: 14 }}>
            <span className={`step-pill ${checks.dockerResponsive ? 'active' : ''}`}>docker: {checks.dockerResponsive ? 'ok' : 'down'}</span>
            <span className={`step-pill ${checks.configMount ? 'active' : ''}`}>/mnt/config</span>
            <span className={`step-pill ${checks.mediaMount ? 'active' : ''}`}>/mnt/media</span>
            <span className={`step-pill ${checks.downloadsMount ? 'active' : ''}`}>/mnt/downloads</span>
          </div>

          <div className="wizard-grid">
            <div><label>Config Root</label><input value={config.paths.configRoot || ''} onChange={(e) => update('paths.configRoot', e.target.value)} /></div>
            <div><label>Media Root</label><input value={config.paths.mediaRoot || ''} onChange={(e) => update('paths.mediaRoot', e.target.value)} /></div>
            <div><label>Downloads Root</label><input value={config.paths.downloadsRoot || ''} onChange={(e) => update('paths.downloadsRoot', e.target.value)} /></div>
            <div><label>Timezone</label><input value={config.runtime.timezone || ''} onChange={(e) => update('runtime.timezone', e.target.value)} /></div>
            <div><label>PUID</label><input value={config.runtime.puid || ''} onChange={(e) => update('runtime.puid', e.target.value)} /></div>
            <div><label>PGID</label><input value={config.runtime.pgid || ''} onChange={(e) => update('runtime.pgid', e.target.value)} /></div>
          </div>

          <div className="grid-2">
            <div>
              <h3>📺 Sonarr</h3>
              <label><input type="checkbox" checked={config.sonarr.enabled} onChange={(e) => update('sonarr.enabled', e.target.checked)} /> enabled</label>
              <label>Port</label><input value={config.sonarr.port} onChange={(e) => update('sonarr.port', e.target.value)} />
              <label>TV Path</label><input value={config.sonarr.tvRoot} onChange={(e) => update('sonarr.tvRoot', e.target.value)} />
            </div>
            <div>
              <h3>🎬 Radarr</h3>
              <label><input type="checkbox" checked={config.radarr.enabled} onChange={(e) => update('radarr.enabled', e.target.checked)} /> enabled</label>
              <label>Port</label><input value={config.radarr.port} onChange={(e) => update('radarr.port', e.target.value)} />
              <label>Movie Path</label><input value={config.radarr.movieRoot} onChange={(e) => update('radarr.movieRoot', e.target.value)} />
            </div>
          </div>

          <div className="card" style={{ marginTop: 16, padding: 16 }}>
            <h3>🔽 SABnzbd</h3>
            <label><input type="checkbox" checked={config.sabnzbd.enabled} onChange={(e) => update('sabnzbd.enabled', e.target.checked)} /> enabled</label>
            <div className="grid-2">
              <div><label>Port</label><input value={config.sabnzbd.port} onChange={(e) => update('sabnzbd.port', e.target.value)} /></div>
              <div><label>TV Category</label><input value={config.sabnzbd.tvCategory} onChange={(e) => update('sabnzbd.tvCategory', e.target.value)} /></div>
            </div>
            <label>Movie Category</label><input value={config.sabnzbd.movieCategory} onChange={(e) => update('sabnzbd.movieCategory', e.target.value)} />
          </div>

          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={wizardInstallNow} onChange={(e) => setWizardInstallNow(e.target.checked)} /> install selected services immediately
          </label>

          <button onClick={completeWizard}>✓ complete setup</button>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="inline-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>⚙ Container Runtime</h2>
              <button className="secondary" onClick={() => setSettingsOpen(true)} title="Settings">⚙ settings</button>
            </div>
            <button onClick={startDeploy} disabled={deployState.running}>{deployState.running ? 'deploying...' : '→ deploy enabled services'}</button>
            <table>
              <thead><tr><th>Service</th><th>Status</th><th>Image</th><th>Controls</th></tr></thead>
              <tbody>
                {containers.map((c) => (
                  <tr key={c.name}>
                    <td><strong>{c.name}</strong></td>
                    <td>{c.status}</td>
                    <td>{c.image || '-'}</td>
                    <td>
                      <button className="secondary" onClick={() => containerAction(c.name, 'start')}>start</button>
                      <button className="secondary" onClick={() => containerAction(c.name, 'stop')}>stop</button>
                      <button className="secondary" onClick={() => containerAction(c.name, 'restart')}>restart</button>
                      <button className="secondary" onClick={() => startDeployForApp(c.name)} disabled={deployState.running}>deploy</button>
                      <button className="secondary" onClick={() => testConnection(c.name)}>test</button>
                      <button className="secondary" onClick={() => openYamlEditor(c.name)}>yaml</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

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
              <button className="secondary" onClick={restartWizard}>⟲ start setup wizard</button>
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
    </div>
  );
}

export default App;

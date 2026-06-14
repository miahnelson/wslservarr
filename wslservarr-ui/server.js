const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Docker = require('dockerode');
const { execFile } = require('child_process');
const { promisify } = require('util');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const PORT = process.env.PORT || 5055;
const CONFIG_PATH = process.env.CONFIG_PATH || '/data/config.json';
const TARGET_CONTAINERS = ['sonarr', 'radarr', 'sabnzbd'];
const APPS_COMPOSE_PATH = '/opt/wslservarr/compose.apps.yml';
const execFileAsync = promisify(execFile);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ensureConfig() {
  if (!fs.existsSync(path.dirname(CONFIG_PATH))) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    const sample = {
      sonarr: { 
        enabled: false,
        url: 'http://sonarr:8989', 
        apiKey: '',
        port: 8989,
        tvRoot: '/mnt/media/tv'
      },
      radarr: { 
        enabled: false,
        url: 'http://radarr:7878', 
        apiKey: '',
        port: 7878,
        movieRoot: '/mnt/media/movies'
      },
      sabnzbd: { 
        enabled: false,
        url: 'http://sabnzbd:8080', 
        apiKey: '',
        port: 8080,
        tvCategory: 'tv', 
        movieCategory: 'movies'
      },
      paths: { 
        mediaRoot: '/mnt/media',
        downloadsRoot: '/mnt/downloads'
      },
      runtime: { 
        timezone: 'America/New_York', 
        puid: '1000', 
        pgid: '1000' 
      },
      setup: {
        completed: false,
        completedAt: null
      },
      composeYaml: ''
    };
    sample.composeYaml = buildAppsCompose(normalizeConfig(sample));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(sample, null, 2));
  }
}

function readConfig() {
  ensureConfig();
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(config) {
  const next = normalizeConfig(config);
  if (!next.composeYaml || !String(next.composeYaml).trim()) {
    next.composeYaml = buildAppsCompose(next);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
}

function apiClient(baseUrl, apiKey) {
  return axios.create({
    baseURL: baseUrl,
    timeout: 10000,
    headers: { 'X-Api-Key': apiKey }
  });
}

async function testArr(url, apiKey) {
  const client = apiClient(url, apiKey);
  const res = await client.get('/api/v3/system/status');
  return { name: res.data.appName || 'Unknown', version: res.data.version || 'Unknown' };
}

async function testSab(url, apiKey) {
  const res = await axios.get(`${url.replace(/\/$/, '')}/api`, {
    params: { mode: 'queue', output: 'json', apikey: apiKey },
    timeout: 10000
  });
  if (!res.data || typeof res.data !== 'object') {
    throw new Error('Invalid SABnzbd response');
  }
  return { status: 'ok' };
}

async function upsertArrDownloadClient(appName, cfg) {
  const isSonarr = appName === 'sonarr';
  const arr = isSonarr ? cfg.sonarr : cfg.radarr;
  const category = isSonarr ? cfg.sabnzbd.tvCategory : cfg.sabnzbd.movieCategory;

  const client = apiClient(arr.url, arr.apiKey);
  const schemaRes = await client.get('/api/v3/downloadclient/schema');
  const schema = schemaRes.data.find(s => s.implementationName === 'SABnzbd');
  if (!schema) throw new Error(`${appName}: SABnzbd schema not found`);

  const fields = (schema.fields || []).map(f => {
    const next = { ...f };
    if (f.name === 'host') next.value = cfg.sabnzbd.url;
    if (f.name === 'apiKey') next.value = cfg.sabnzbd.apiKey;
    if (f.name === 'tvCategory') next.value = cfg.sabnzbd.tvCategory;
    if (f.name === 'movieCategory') next.value = cfg.sabnzbd.movieCategory;
    if (f.name === 'category') next.value = category;
    return next;
  });

  const listRes = await client.get('/api/v3/downloadclient');
  const existing = listRes.data.find(dc => dc.implementationName === 'SABnzbd');

  const payload = {
    ...(existing || {}),
    enable: true,
    name: 'SABnzbd',
    priority: 1,
    implementation: schema.implementation,
    implementationName: schema.implementationName,
    configContract: schema.configContract,
    protocol: 'usenet',
    fields,
    tags: existing?.tags || []
  };

  if (existing && existing.id) {
    await client.put(`/api/v3/downloadclient/${existing.id}`, payload);
  } else {
    await client.post('/api/v3/downloadclient', payload);
  }
}

async function ensureRootFolder(appName, cfg) {
  const arr = appName === 'sonarr' ? cfg.sonarr : cfg.radarr;
  const rootPath = appName === 'sonarr' ? arr.tvRoot : arr.movieRoot;
  
  const client = apiClient(arr.url, arr.apiKey);
  const list = await client.get('/api/v3/rootfolder');
  const exists = list.data.some(r => r.path === rootPath || r.path === `${rootPath}/`);
  if (!exists) {
    await client.post('/api/v3/rootfolder', { path: rootPath });
  }
}

async function getContainerStatuses() {
  const all = await withTimeout(docker.listContainers({ all: true }), 4000, 'docker.listContainers');
  const map = new Map();

  for (const c of all) {
    for (const n of c.Names || []) {
      const clean = n.replace(/^\//, '');
      map.set(clean, c);
    }
  }

  return TARGET_CONTAINERS.map(name => {
    const c = map.get(name);
    if (!c) return { name, status: 'missing' };
    return {
      name,
      status: c.State === 'running' ? 'running' : 'stopped',
      image: c.Image
    };
  });
}

function normalizeConfig(config) {
  const next = { ...config };
  next.sonarr = next.sonarr || { enabled: false, url: 'http://sonarr:8989', apiKey: '', port: '8989', tvRoot: '/mnt/media/tv' };
  next.radarr = next.radarr || { enabled: false, url: 'http://radarr:7878', apiKey: '', port: '7878', movieRoot: '/mnt/media/movies' };
  next.sabnzbd = next.sabnzbd || { enabled: false, url: 'http://sabnzbd:8080', apiKey: '', port: '8080', tvCategory: 'tv', movieCategory: 'movies' };
  next.paths = next.paths || { mediaRoot: '/mnt/media', downloadsRoot: '/mnt/downloads' };
  next.runtime = next.runtime || {};
  next.runtime.timezone = next.runtime.timezone || 'America/New_York';
  next.runtime.puid = String(next.runtime.puid || '1000');
  next.runtime.pgid = String(next.runtime.pgid || '1000');
  next.setup = next.setup || {};
  next.setup.completed = Boolean(next.setup.completed);
  next.setup.completedAt = next.setup.completedAt || null;
  next.composeYaml = typeof next.composeYaml === 'string' ? next.composeYaml : '';
  if (!next.composeYaml.trim()) {
    next.composeYaml = buildAppsCompose(next);
  }
  return next;
}

function buildConfigFromBody(body) {
  const prev = normalizeConfig(readConfig());
  const next = normalizeConfig({
    sonarr: {
      enabled: body.sonarrEnabled === 'on' || body.sonarrEnabled === true,
      url: body.sonarrUrl || prev.sonarr.url || 'http://sonarr:8989',
      apiKey: body.sonarrApiKey || '',
      port: body.sonarrPort || '8989',
      tvRoot: body.tvRoot || '/mnt/media/tv'
    },
    radarr: {
      enabled: body.radarrEnabled === 'on' || body.radarrEnabled === true,
      url: body.radarrUrl || prev.radarr.url || 'http://radarr:7878',
      apiKey: body.radarrApiKey || '',
      port: body.radarrPort || '7878',
      movieRoot: body.movieRoot || '/mnt/media/movies'
    },
    sabnzbd: {
      enabled: body.sabnzbdEnabled === 'on' || body.sabnzbdEnabled === true,
      url: body.sabUrl || prev.sabnzbd.url || 'http://sabnzbd:8080',
      apiKey: body.sabApiKey || '',
      port: body.sabPort || '8080',
      tvCategory: body.tvCategory || 'tv',
      movieCategory: body.movieCategory || 'movies'
    },
    paths: {
      mediaRoot: body.mediaRoot || '/mnt/media',
      downloadsRoot: body.downloadsRoot || '/mnt/downloads',
      configRoot: body.configRoot || prev.paths.configRoot || '/mnt/config'
    },
    runtime: {
      timezone: body.timezone || 'America/New_York',
      puid: body.puid || '1000',
      pgid: body.pgid || '1000'
    },
    setup: prev.setup,
    composeYaml: typeof body.composeYaml === 'string' ? body.composeYaml : prev.composeYaml
  });
  if (!next.composeYaml || !next.composeYaml.trim()) {
    next.composeYaml = buildAppsCompose(next);
  }
  return next;
}

async function getDashboardData() {
  const config = normalizeConfig(readConfig());
  let containers = [];
  try {
    containers = await getContainerStatuses();
  } catch (e) {
    containers = TARGET_CONTAINERS.map(name => ({ name, status: `error: ${e.message}` }));
  }
  return { config, containers };
}

async function getWizardChecks() {
  const checks = {
    dockerSocket: fs.existsSync('/var/run/docker.sock'),
    configMount: fs.existsSync('/mnt/config'),
    mediaMount: fs.existsSync('/mnt/media'),
    downloadsMount: fs.existsSync('/mnt/downloads'),
    composeBaseExists: fs.existsSync('/opt/wslservarr/compose.yml'),
    dockerResponsive: false,
    dockerError: ''
  };

  try {
    await withTimeout(docker.ping(), 3000, 'docker.ping');
    checks.dockerResponsive = true;
  } catch (e) {
    checks.dockerError = e.message;
  }

  return checks;
}

function validateWizardPayload(body) {
  const errors = [];
  const warnings = [];

  const sonarrEnabled = body.sonarrEnabled === 'on';
  const radarrEnabled = body.radarrEnabled === 'on';
  const sabnzbdEnabled = body.sabnzbdEnabled === 'on';

  if (!sonarrEnabled && !radarrEnabled && !sabnzbdEnabled) {
    errors.push('Select at least one application.');
  }

  const mediaRoot = (body.mediaRoot || '/mnt/media').trim();
  const downloadsRoot = (body.downloadsRoot || '/mnt/downloads').trim();
  const configRoot = (body.configRoot || '/mnt/config').trim();

  for (const [name, value] of [['Media Root', mediaRoot], ['Downloads Root', downloadsRoot], ['Config Root', configRoot]]) {
    if (!value.startsWith('/mnt/')) {
      warnings.push(`${name} usually should be under /mnt for mounted Windows storage.`);
    }
  }

  const ports = [];
  if (sonarrEnabled) ports.push({ app: 'sonarr', port: String(body.sonarrPort || '8989').trim() });
  if (radarrEnabled) ports.push({ app: 'radarr', port: String(body.radarrPort || '7878').trim() });
  if (sabnzbdEnabled) ports.push({ app: 'sabnzbd', port: String(body.sabnzbdPort || '8080').trim() });

  const seen = new Map();
  for (const p of ports) {
    if (!/^\d+$/.test(p.port)) {
      errors.push(`${p.app} port must be numeric.`);
      continue;
    }
    const num = Number(p.port);
    if (num < 1 || num > 65535) {
      errors.push(`${p.app} port must be between 1 and 65535.`);
      continue;
    }
    if (seen.has(p.port)) {
      errors.push(`Port conflict: ${p.app} and ${seen.get(p.port)} both use ${p.port}.`);
    } else {
      seen.set(p.port, p.app);
    }
  }

  return { errors, warnings };
}

function buildAppsCompose(cfg) {
  const tz = cfg.runtime.timezone;
  const puid = cfg.runtime.puid;
  const pgid = cfg.runtime.pgid;
  const mediaRoot = cfg.paths.mediaRoot || '/mnt/media';
  const downloadsRoot = cfg.paths.downloadsRoot || '/mnt/downloads';

  let compose = 'services:\n';

  if (cfg.sabnzbd.enabled) {
    compose += `  sabnzbd:
    image: lscr.io/linuxserver/sabnzbd:latest
    container_name: sabnzbd
    environment:
      - PUID=${puid}
      - PGID=${pgid}
      - TZ=${tz}
    volumes:
      - /mnt/config/sabnzbd:/config
      - ${downloadsRoot}:/downloads
    ports:
      - "${cfg.sabnzbd.port}:8080"
    restart: unless-stopped

`;
  }

  if (cfg.sonarr.enabled) {
    compose += `  sonarr:
    image: lscr.io/linuxserver/sonarr:latest
    container_name: sonarr
    environment:
      - PUID=${puid}
      - PGID=${pgid}
      - TZ=${tz}
    volumes:
      - /mnt/config/sonarr:/config
      - ${mediaRoot}:/media
      - ${downloadsRoot}:/downloads
    ports:
      - "${cfg.sonarr.port}:8989"
    restart: unless-stopped

`;
  }

  if (cfg.radarr.enabled) {
    compose += `  radarr:
    image: lscr.io/linuxserver/radarr:latest
    container_name: radarr
    environment:
      - PUID=${puid}
      - PGID=${pgid}
      - TZ=${tz}
    volumes:
      - /mnt/config/radarr:/config
      - ${mediaRoot}:/media
      - ${downloadsRoot}:/downloads
    ports:
      - "${cfg.radarr.port}:7878"
    restart: unless-stopped

`;
  }

  return compose;
}

async function installOrUpdateApps(config) {
  const cfg = normalizeConfig(config);
  const dirs = ['/srv/config/sonarr', '/srv/config/radarr', '/srv/config/sabnzbd', '/srv/downloads', '/srv/media'];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }

  const composeYaml = (cfg.composeYaml && cfg.composeYaml.trim()) ? cfg.composeYaml : buildAppsCompose(cfg);
  fs.writeFileSync(APPS_COMPOSE_PATH, composeYaml);
  await execFileAsync('docker', ['compose', '-f', APPS_COMPOSE_PATH, 'pull']);
  await execFileAsync('docker', ['compose', '-f', APPS_COMPOSE_PATH, 'up', '-d']);
}

function isFirstRun() {
  if (!fs.existsSync(CONFIG_PATH)) return true;
  const config = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  if (config.setup?.completed) return false;
  // Backward compatibility for existing installs without setup metadata
  return !config.sonarr?.enabled && !config.radarr?.enabled && !config.sabnzbd?.enabled;
}

app.get('/wizard', async (req, res) => {
  const forceMode = req.query.force === '1';
  if (!isFirstRun() && !forceMode) {
    return res.redirect('/');
  }

  const config = normalizeConfig(readConfig());
  const checks = await getWizardChecks();
  res.render('wizard', {
    config,
    checks,
    forceMode,
    message: req.query.message || '',
    error: req.query.error || ''
  });
});

app.post('/wizard', async (req, res) => {
  const forceMode = req.query.force === '1' || req.body.forceMode === '1';
  if (!isFirstRun() && !forceMode) {
    return res.redirect('/');
  }

  const validation = validateWizardPayload(req.body);
  if (validation.errors.length > 0) {
    return res.redirect(`/wizard?error=${encodeURIComponent(validation.errors.join(' '))}`);
  }

  const config = normalizeConfig({
    sonarr: {
      enabled: req.body.sonarrEnabled === 'on',
      url: 'http://sonarr:8989',
      apiKey: '',
      port: req.body.sonarrPort || '8989',
      tvRoot: req.body.sonarrMediaPath || '/mnt/media/tv'
    },
    radarr: {
      enabled: req.body.radarrEnabled === 'on',
      url: 'http://radarr:7878',
      apiKey: '',
      port: req.body.radarrPort || '7878',
      movieRoot: req.body.radarrMediaPath || '/mnt/media/movies'
    },
    sabnzbd: {
      enabled: req.body.sabnzbdEnabled === 'on',
      url: 'http://sabnzbd:8080',
      apiKey: '',
      port: req.body.sabnzbdPort || '8080',
      tvCategory: req.body.tvCategory || 'tv',
      movieCategory: req.body.movieCategory || 'movies'
    },
    paths: {
      mediaRoot: req.body.mediaRoot || '/mnt/media',
      downloadsRoot: req.body.downloadsRoot || '/mnt/downloads',
      configRoot: req.body.configRoot || '/mnt/config'
    },
    runtime: {
      timezone: req.body.timezone || 'America/New_York',
      puid: req.body.puid || '1000',
      pgid: req.body.pgid || '1000'
    },
    setup: {
      completed: true,
      completedAt: new Date().toISOString()
    },
    composeYaml: ''
  });

  writeConfig(config);

  if (req.body.installNow === 'on') {
    try {
      await installOrUpdateApps(config);
      return res.redirect('/?message=Wizard completed and selected apps were installed.');
    } catch (e) {
      return res.redirect(`/?error=${encodeURIComponent(`Wizard completed, but install failed: ${e.message}`)}`);
    }
  }

  return res.redirect('/?message=Wizard completed! Configure your apps above.');
});

app.post('/wizard/restart', (req, res) => {
  const cfg = normalizeConfig(readConfig());
  cfg.setup = {
    completed: false,
    completedAt: null
  };
  writeConfig(cfg);
  res.redirect('/wizard?force=1&message=Setup wizard restarted');
});

app.get('/api/wizard/checks', async (req, res) => {
  try {
    const checks = await getWizardChecks();
    res.json({ ok: true, checks });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/wizard/validate', (req, res) => {
  const validation = validateWizardPayload(req.body || {});
  res.json({ ok: validation.errors.length === 0, ...validation });
});

app.get('/', async (req, res) => {
  // Check if this is first run
  if (isFirstRun()) {
    return res.redirect('/wizard');
  }

  const { config, containers } = await getDashboardData();

  res.render('index', {
    config,
    containers,
    message: req.query.message || '',
    error: req.query.error || ''
  });
});

app.post('/config', (req, res) => {
  const next = buildConfigFromBody(req.body || {});
  writeConfig(next);
  res.redirect('/?message=Configuration saved');
});

app.get('/api/status', async (req, res) => {
  const checks = await getWizardChecks();
  const data = await getDashboardData();
  res.json({ ok: true, ...data, checks });
});

app.get('/api/config', async (req, res) => {
  const data = await getDashboardData();
  res.json({ ok: true, ...data });
});

app.post('/api/config', (req, res) => {
  try {
    const next = buildConfigFromBody(req.body || {});
    writeConfig(next);
    res.json({ ok: true, config: next });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/compose', (req, res) => {
  const cfg = normalizeConfig(readConfig());
  res.json({ ok: true, composeYaml: cfg.composeYaml || buildAppsCompose(cfg) });
});

app.post('/compose', (req, res) => {
  const cfg = normalizeConfig(readConfig());
  cfg.composeYaml = typeof req.body.composeYaml === 'string' ? req.body.composeYaml : cfg.composeYaml;
  writeConfig(cfg);
  res.redirect('/?message=Compose YAML saved to UI config');
});

app.post('/test/:appName', async (req, res) => {
  try {
    const cfg = readConfig();
    const appName = req.params.appName;
    if (appName === 'sonarr') await testArr(cfg.sonarr.url, cfg.sonarr.apiKey);
    else if (appName === 'radarr') await testArr(cfg.radarr.url, cfg.radarr.apiKey);
    else if (appName === 'sabnzbd') await testSab(cfg.sabnzbd.url, cfg.sabnzbd.apiKey);
    else throw new Error('Unknown app');

    res.redirect(`/?message=${encodeURIComponent(`${appName} connection OK`)}`);
  } catch (e) {
    res.redirect(`/?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/api/test/:appName', async (req, res) => {
  try {
    const cfg = readConfig();
    const appName = req.params.appName;
    if (appName === 'sonarr') await testArr(cfg.sonarr.url, cfg.sonarr.apiKey);
    else if (appName === 'radarr') await testArr(cfg.radarr.url, cfg.radarr.apiKey);
    else if (appName === 'sabnzbd') await testSab(cfg.sabnzbd.url, cfg.sabnzbd.apiKey);
    else throw new Error('Unknown app');

    res.json({ ok: true, message: `${appName} connection OK` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/apply', async (req, res) => {
  try {
    const cfg = readConfig();

    if (cfg.sonarr.enabled && cfg.sonarr.apiKey) {
      await ensureRootFolder('sonarr', cfg);
      await upsertArrDownloadClient('sonarr', cfg);
    }

    if (cfg.radarr.enabled && cfg.radarr.apiKey) {
      await ensureRootFolder('radarr', cfg);
      await upsertArrDownloadClient('radarr', cfg);
    }

    res.redirect('/?message=Applied settings to enabled Arr apps');
  } catch (e) {
    res.redirect(`/?error=${encodeURIComponent(`Apply failed: ${e.message}`)}`);
  }
});

app.post('/api/apply', async (req, res) => {
  try {
    const cfg = readConfig();

    if (cfg.sonarr.enabled && cfg.sonarr.apiKey) {
      await ensureRootFolder('sonarr', cfg);
      await upsertArrDownloadClient('sonarr', cfg);
    }

    if (cfg.radarr.enabled && cfg.radarr.apiKey) {
      await ensureRootFolder('radarr', cfg);
      await upsertArrDownloadClient('radarr', cfg);
    }

    res.json({ ok: true, message: 'Applied settings to enabled Arr apps' });
  } catch (e) {
    res.status(500).json({ ok: false, error: `Apply failed: ${e.message}` });
  }
});

app.post('/install/apps', async (req, res) => {
  try {
    const cfg = normalizeConfig(readConfig());
    await installOrUpdateApps(cfg);
    res.redirect('/?message=Installed or updated Sonarr, Radarr, and SABnzbd');
  } catch (e) {
    res.redirect(`/?error=${encodeURIComponent(`Install failed: ${e.message}`)}`);
  }
});

app.post('/api/install/apps', async (req, res) => {
  try {
    const cfg = normalizeConfig(readConfig());
    await installOrUpdateApps(cfg);
    res.json({ ok: true, message: 'Installed or updated Sonarr, Radarr, and SABnzbd' });
  } catch (e) {
    res.status(500).json({ ok: false, error: `Install failed: ${e.message}` });
  }
});

app.post('/container/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  if (!TARGET_CONTAINERS.includes(name)) {
    return res.status(400).json({ error: 'Invalid container' });
  }

  try {
    const container = docker.getContainer(name);
    if (action === 'start') await container.start();
    else if (action === 'stop') await container.stop();
    else if (action === 'restart') await container.restart();
    else return res.status(400).json({ error: 'Invalid action' });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  ensureConfig();
  console.log(`wslservarr-ui listening on ${PORT}`);
});

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Docker = require('dockerode');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const SPA_DIST_PATH = path.join(__dirname, 'dist');

const PORT = process.env.PORT || 5055;
const CONFIG_PATH = process.env.CONFIG_PATH || '/data/config.json';
const DIAGNOSTICS_DIR = process.env.DIAGNOSTICS_DIR || '/data/diagnostics';
const API_TOKEN = (process.env.WSLSERVARR_API_TOKEN || '').trim();
const TARGET_CONTAINERS = ['sabnzbd', 'prowlarr', 'sonarr', 'radarr', 'jellyfin'];
const APPS_COMPOSE_PATH = '/opt/wslservarr/compose.apps.yml';
const SHARED_DOCKER_NETWORK = 'wslservarr';
const SABNZBD_CONFIG_PATH = '/mnt/config/sabnzbd/sabnzbd.ini';
const PROWLARR_SAB_CATEGORY = 'prowlarr';
const execFileAsync = promisify(execFile);
const deployClients = new Set();
const deployState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  success: null,
  error: '',
  logs: []
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(SPA_DIST_PATH));
app.use(express.json());

app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function getRequestToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  const xApiToken = req.headers['x-api-token'];
  if (typeof xApiToken === 'string' && xApiToken.trim()) {
    return xApiToken.trim();
  }
  if (Array.isArray(xApiToken) && xApiToken.length) {
    return String(xApiToken[0] || '').trim();
  }

  if (typeof req.query?.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }

  return '';
}

function requireApiToken(req, res, next) {
  if (!API_TOKEN) return next();
  if (getRequestToken(req) !== API_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  return next();
}

app.use('/api', requireApiToken);
app.use('/container', requireApiToken);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function emitDeployEvent(type, payload = {}) {
  const message = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const client of deployClients) {
    client.write(message);
  }
}

function pushDeployLog(line) {
  const text = String(line || '').replace(/\r/g, '');
  if (!text.trim()) return;
  deployState.logs.push(text);
  if (deployState.logs.length > 1000) {
    deployState.logs = deployState.logs.slice(-1000);
  }
  emitDeployEvent('log', { line: text, state: deployState });
}

function setDeployState(patch) {
  Object.assign(deployState, patch);
  emitDeployEvent('state', { state: deployState });
}

async function retryAsync(fn, attempts = 6, delayMs = 2500) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function runCommandWithProgress(command, args, label, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        COMPOSE_IGNORE_ORPHANS: 'true'
      }
    });
    const prefix = label ? `[${label}] ` : '';
    const log = (line) => {
      if (onProgress) onProgress(`${prefix}${line}`);
    };

    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) log(line);
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';
      for (const line of lines) log(line);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) log(stdoutBuffer.trim());
      if (stderrBuffer.trim()) log(stderrBuffer.trim());
      if (code === 0) return resolve();
      reject(new Error(`${label || command} failed with exit code ${code}`));
    });
  });
}

function ensureDiagnosticsDir() {
  if (!fs.existsSync(DIAGNOSTICS_DIR)) {
    fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
  }
}

function readXmlTagValue(filePath, tagName) {
  if (!fs.existsSync(filePath)) return '';
  const text = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'i');
  const m = text.match(re);
  return m?.[1]?.trim() || '';
}

function readIniKeyValue(filePath, keyName) {
  if (!fs.existsSync(filePath)) return '';
  const text = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`^\\s*${keyName}\\s*=\\s*(.+)\\s*$`, 'im');
  const m = text.match(re);
  return m?.[1]?.trim() || '';
}

function discoverApiKeysFromMountedConfig() {
  const found = {};

  const sonarrKey = readXmlTagValue('/mnt/config/sonarr/config.xml', 'ApiKey');
  if (sonarrKey) found.sonarr = sonarrKey;

  const radarrKey = readXmlTagValue('/mnt/config/radarr/config.xml', 'ApiKey');
  if (radarrKey) found.radarr = radarrKey;

  const sabKey = readIniKeyValue('/mnt/config/sabnzbd/sabnzbd.ini', 'api_key');
    if (sabKey) found.sabnzbd = sabKey;

  const prowlarrKey = readXmlTagValue('/mnt/config/prowlarr/config.xml', 'ApiKey');
  if (prowlarrKey) found.prowlarr = prowlarrKey;

  return found;
}

function mergeDiscoveredApiKeys(cfg, found = discoverApiKeysFromMountedConfig()) {
  const next = normalizeConfig(cfg);

  if (found.sonarr && !next.sonarr.apiKey) next.sonarr.apiKey = found.sonarr;
  if (found.radarr && !next.radarr.apiKey) next.radarr.apiKey = found.radarr;
  if (found.sabnzbd && !next.sabnzbd.apiKey) next.sabnzbd.apiKey = found.sabnzbd;
  if (found.prowlarr && !next.prowlarr.apiKey) next.prowlarr.apiKey = found.prowlarr;

  return next;
}

async function execForDiagnostics(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 10 });
    return `${stdout || ''}${stderr || ''}`.trim();
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim();
    return out || e.message;
  }
}

function buildDiagLogPath(appName, ts) {
  const safe = ts.replace(/[:.]/g, '-');
  return path.join(DIAGNOSTICS_DIR, `${appName}-${safe}.log`);
}

async function captureDiagnostics(appName) {
  ensureDiagnosticsDir();
  const ts = new Date().toISOString();
  const lines = [];

  lines.push(`# wslservarr diagnostics`);
  lines.push(`timestamp: ${ts}`);
  lines.push(`app: ${appName}`);
  lines.push('');

  const inspect = await execForDiagnostics('docker', ['inspect', appName]);
  lines.push('## docker inspect');
  lines.push(inspect || '(no output)');
  lines.push('');

  const dockerLogs = await execForDiagnostics('docker', ['logs', '--tail', '400', appName]);
  lines.push('## docker logs --tail 400');
  lines.push(dockerLogs || '(no output)');
  lines.push('');

  const appLogPath = `/mnt/config/${appName}/logs/${appName}.txt`;
  const appDebugPath = `/mnt/config/${appName}/logs/${appName}.debug.txt`;
  const appLogTail = await execForDiagnostics('bash', ['-lc', `if [ -f ${appLogPath} ]; then tail -n 400 ${appLogPath}; else echo missing:${appLogPath}; fi`]);
  const appDebugTail = await execForDiagnostics('bash', ['-lc', `if [ -f ${appDebugPath} ]; then tail -n 400 ${appDebugPath}; else echo missing:${appDebugPath}; fi`]);
  lines.push(`## tail -n 400 ${appLogPath}`);
  lines.push(appLogTail || '(no output)');
  lines.push('');
  lines.push(`## tail -n 400 ${appDebugPath}`);
  lines.push(appDebugTail || '(no output)');
  lines.push('');

  const composeTail = await execForDiagnostics('bash', ['-lc', `if [ -f ${APPS_COMPOSE_PATH} ]; then sed -n '1,260p' ${APPS_COMPOSE_PATH}; else echo missing:${APPS_COMPOSE_PATH}; fi`]);
  lines.push(`## ${APPS_COMPOSE_PATH}`);
  lines.push(composeTail || '(no output)');

  const content = lines.join('\n');
  const filePath = buildDiagLogPath(appName, ts);
  fs.writeFileSync(filePath, content);

  return {
    appName,
    timestamp: ts,
    filePath,
    content
  };
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
        tvRoot: '/media/tv'
      },
      radarr: { 
        enabled: false,
        url: 'http://radarr:7878', 
        apiKey: '',
        port: 7878,
        movieRoot: '/media/movies'
      },
      sabnzbd: { 
        enabled: false,
        url: 'http://sabnzbd:8080', 
        apiKey: '',
        port: 8080,
        tvCategory: 'tv', 
        movieCategory: 'movies'
      },
      prowlarr: {
        enabled: false,
        url: 'http://prowlarr:9696',
        apiKey: '',
        port: 9696
      },
      jellyfin: {
        enabled: false,
        url: 'http://jellyfin:8096',
        apiKey: '',
        port: 8096
      },
      newshosting: {
        enabled: false,
        name: 'newshosting',
        host: 'news.newshosting.com',
        port: 563,
        username: '',
        password: '',
        ssl: true,
        connections: 40,
        retention: 0,
        optional: false
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

function readEffectiveConfig({ persist = false } = {}) {
  const raw = readConfig();
  const normalizedRaw = normalizeConfig(raw);
  const merged = mergeDiscoveredApiKeys(raw);
  const normalizedMerged = normalizeConfig(merged);

  if (persist && JSON.stringify(normalizedRaw) !== JSON.stringify(normalizedMerged)) {
    writeConfig(normalizedMerged);
  }

  return normalizedMerged;
}

function apiClient(baseUrl, apiKey) {
  return axios.create({
    baseURL: baseUrl,
    timeout: 10000,
    headers: { 'X-Api-Key': apiKey }
  });
}

async function ensureSharedDockerNetwork() {
  try {
    await docker.getNetwork(SHARED_DOCKER_NETWORK).inspect();
  } catch {
    try {
      await docker.createNetwork({
        Name: SHARED_DOCKER_NETWORK,
        CheckDuplicate: true,
        Driver: 'bridge',
        Attachable: true,
        Internal: false
      });
    } catch (e) {
      if (!String(e?.message || '').toLowerCase().includes('already exists')) {
        throw e;
      }
    }
  }
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

async function testJellyfin(url, apiKey) {
  const base = `${String(url || '').replace(/\/$/, '')}`;
  const headers = {};
  if (apiKey) headers['X-Emby-Token'] = apiKey;
  const res = await axios.get(`${base}/System/Info/Public`, {
    timeout: 10000,
    headers
  });
  if (!res.data || typeof res.data !== 'object') {
    throw new Error('Invalid Jellyfin response');
  }
  return { status: 'ok' };
}

async function testProwlarr(url, apiKey) {
  const base = `${String(url || '').replace(/\/$/, '')}`;
  const res = await axios.get(`${base}/api/v1/system/status`, {
    timeout: 10000,
    headers: { 'X-Api-Key': apiKey }
  });
  if (!res.data || typeof res.data !== 'object') {
    throw new Error('Invalid Prowlarr response');
  }
  return { status: 'ok' };
}

function parseDownloadClientUrl(rawUrl, fallbackPort = 8080) {
  const text = String(rawUrl || '').trim();
  if (!text) {
    return { host: 'sabnzbd', port: Number(fallbackPort || 8080), useSsl: false, urlBase: '' };
  }

  try {
    const asUrl = text.includes('://') ? new URL(text) : new URL(`http://${text}`);
    const host = asUrl.hostname || 'sabnzbd';
    const useSsl = asUrl.protocol === 'https:';
    const port = Number(asUrl.port || (useSsl ? 443 : fallbackPort || 8080));
    const pathname = String(asUrl.pathname || '').replace(/^\/+|\/+$/g, '');
    return { host, port, useSsl, urlBase: pathname };
  } catch {
    return { host: text, port: Number(fallbackPort || 8080), useSsl: false, urlBase: '' };
  }
}

function normalizeAppServiceUrl(appName, rawUrl, fallbackPort) {
  const text = String(rawUrl || '').trim();
  const safePort = Number(fallbackPort) > 0 ? Number(fallbackPort) : (INTERNAL_SERVICE_PORTS[appName] || 80);
  if (!text) return `http://${appName}:${safePort}`;

  try {
    const asUrl = text.includes('://') ? new URL(text) : new URL(`http://${text}`);
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(String(asUrl.hostname || '').toLowerCase());
    const protocol = asUrl.protocol || 'http:';
    const host = isLoopback ? appName : asUrl.hostname;
    const port = Number(asUrl.port || safePort);
    const normalizedPath = String(asUrl.pathname || '').replace(/\/$/, '');
    return `${protocol}//${host}:${port}${normalizedPath}`;
  } catch {
    return `http://${appName}:${safePort}`;
  }
}

const INTERNAL_SERVICE_PORTS = {
  sabnzbd: 8080,
  prowlarr: 9696,
  sonarr: 8989,
  radarr: 7878,
  jellyfin: 8096
};

function getInternalServiceUrl(cfg, appName) {
  const appCfg = cfg?.[appName] || {};
  const raw = String(appCfg.url || '').trim().toLowerCase();
  const protocol = raw.startsWith('https://') ? 'https' : 'http';
  let port = Number(appCfg.port || INTERNAL_SERVICE_PORTS[appName] || 80);
  if (!Number.isFinite(port) || port <= 0) {
    port = INTERNAL_SERVICE_PORTS[appName] || 80;
  }
  return `${protocol}://${appName}:${port}`;
}

async function upsertArrDownloadClient(appName, cfg) {
  const isSonarr = appName === 'sonarr';
  const arr = isSonarr ? cfg.sonarr : cfg.radarr;
  const category = isSonarr ? cfg.sabnzbd.tvCategory : cfg.sabnzbd.movieCategory;
  const sabConn = parseDownloadClientUrl(getInternalServiceUrl(cfg, 'sabnzbd'), cfg.sabnzbd.port);

  const client = apiClient(getInternalServiceUrl(cfg, isSonarr ? 'sonarr' : 'radarr'), arr.apiKey);
  const schemaRes = await client.get('/api/v3/downloadclient/schema');
  const schema = schemaRes.data.find(s => s.implementationName === 'SABnzbd');
  if (!schema) throw new Error(`${appName}: SABnzbd schema not found`);

  const fields = (schema.fields || []).map(f => {
    const next = { ...f };
    if (f.name === 'host') next.value = sabConn.host;
    if (f.name === 'port') next.value = sabConn.port;
    if (f.name === 'useSsl') next.value = sabConn.useSsl;
    if (f.name === 'urlBase') next.value = sabConn.urlBase;
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

async function upsertProwlarrDownloadClient(cfg) {
  if (!cfg?.prowlarr?.enabled || !cfg?.prowlarr?.apiKey) return;
  if (!cfg?.sabnzbd?.enabled || !cfg?.sabnzbd?.apiKey) return;

  const sabConn = parseDownloadClientUrl(getInternalServiceUrl(cfg, 'sabnzbd'), cfg.sabnzbd.port);
  const client = apiClient(getInternalServiceUrl(cfg, 'prowlarr'), cfg.prowlarr.apiKey);
  const schemaRes = await client.get('/api/v1/downloadclient/schema');
  const schemaList = Array.isArray(schemaRes.data) ? schemaRes.data : [];
  const schema = schemaList.find((s) => s.implementationName === 'SABnzbd');
  if (!schema) throw new Error('Prowlarr: SABnzbd schema not found');

  const fields = (schema.fields || []).map((f) => {
    const next = { ...f };
    if (f.name === 'host') next.value = sabConn.host;
    if (f.name === 'port') next.value = sabConn.port;
    if (f.name === 'useSsl') next.value = sabConn.useSsl;
    if (f.name === 'urlBase') next.value = sabConn.urlBase;
    if (f.name === 'apiKey') next.value = cfg.sabnzbd.apiKey;
    if (f.name === 'category') next.value = PROWLARR_SAB_CATEGORY;
    return next;
  });

  const listRes = await client.get('/api/v1/downloadclient');
  const existingList = Array.isArray(listRes.data) ? listRes.data : [];
  const existing = existingList.find((dc) => dc.implementationName === 'SABnzbd');

  const payload = {
    ...(existing || {}),
    enable: true,
    name: 'SABnzbd',
    priority: 1,
    implementation: schema.implementation,
    implementationName: schema.implementationName,
    configContract: schema.configContract,
    protocol: 'usenet',
    categories: existing?.categories || [],
    supportsCategories: schema.supportsCategories,
    fields,
    tags: existing?.tags || []
  };

  if (existing?.id) {
    await client.put(`/api/v1/downloadclient/${existing.id}`, payload);
  } else {
    await client.post('/api/v1/downloadclient', payload);
  }
}

async function upsertSabNewshostingServer(cfg) {
  if (!cfg?.sabnzbd?.enabled || !cfg?.sabnzbd?.apiKey) return;
  if (!cfg?.newshosting?.enabled) return;

  const ns = cfg.newshosting;
  const sabUrl = getInternalServiceUrl(cfg, 'sabnzbd').replace(/\/$/, '');
  if (!sabUrl) throw new Error('SABnzbd URL is missing');
  if (!ns.host || !ns.username || !ns.password) {
    throw new Error('Newshosting requires host, username, and password');
  }

  const params = {
    mode: 'addserver',
    output: 'json',
    apikey: cfg.sabnzbd.apiKey,
    name: ns.name || 'newshosting',
    host: ns.host,
    port: Number(ns.port || 563),
    username: ns.username,
    password: ns.password,
    ssl: ns.ssl ? 1 : 0,
    connections: Number(ns.connections || 40),
    retention: Number(ns.retention || 0),
    optional: ns.optional ? 1 : 0,
    enable: 1
  };

  const res = await axios.get(`${sabUrl}/api`, { params, timeout: 10000 });
  const body = res.data;
  const text = typeof body === 'string' ? body.toLowerCase() : JSON.stringify(body || {}).toLowerCase();

  const ok = (body && (body.status === true || body.status === 'ok' || body.result === true))
    || text.includes('ok')
    || text.includes('already exists')
    || text.includes('duplicate');

  if (!ok) {
    throw new Error(`Failed to seed Newshosting in SABnzbd: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
}

async function ensureSabDownloadDirectories(cfg, onProgress) {
  if (!cfg?.sabnzbd?.enabled || !cfg?.sabnzbd?.apiKey) return;

  const puid = Number(cfg?.runtime?.puid || 1000);
  const pgid = Number(cfg?.runtime?.pgid || 1000);
  const downloadPaths = ['/mnt/downloads/incomplete', '/mnt/downloads/complete'];

  try {
    for (const dirPath of downloadPaths) {
      fs.mkdirSync(dirPath, { recursive: true });
      try {
        fs.chownSync(dirPath, puid, pgid);
      } catch {
        // Ignore chown failures on host-backed mounts.
      }
      try {
        fs.chmodSync(dirPath, 0o777);
      } catch {
        // Ignore chmod failures on host-backed mounts.
      }
    }
  } catch {
    // Ignore host mkdir failures and let SAB validation surface any path issues.
  }

  const desired = {
    download_dir: '/downloads/incomplete',
    complete_dir: '/downloads/complete'
  };

  let configUpdated = false;
  if (fs.existsSync(SABNZBD_CONFIG_PATH)) {
    let text = fs.readFileSync(SABNZBD_CONFIG_PATH, 'utf8');
    for (const [keyword, value] of Object.entries(desired)) {
      const pattern = new RegExp(`^${keyword}\\s*=\\s*.*$`, 'm');
      const replacement = `${keyword} = ${value}`;
      if (pattern.test(text)) {
        const nextText = text.replace(pattern, replacement);
        if (nextText !== text) {
          text = nextText;
          configUpdated = true;
        }
      } else {
        text = `${text.trimEnd()}\n${replacement}\n`;
        configUpdated = true;
      }
    }

    if (configUpdated) {
      fs.writeFileSync(SABNZBD_CONFIG_PATH, text);
      if (onProgress) onProgress('Updated SABnzbd download paths in sabnzbd.ini. Restarting SABnzbd...');
      await docker.getContainer('sabnzbd').restart();
      await waitForAppReady('sabnzbd', cfg, onProgress);
    }
  }

  const sabUrl = getInternalServiceUrl(cfg, 'sabnzbd').replace(/\/$/, '');

  for (const [keyword, value] of Object.entries(desired)) {
    if (onProgress) onProgress(`Ensuring SABnzbd ${keyword} points to ${value}...`);
    await axios.post(`${sabUrl}/api`, null, {
      params: {
        mode: 'set_config',
        section: 'misc',
        keyword,
        value,
        apikey: cfg.sabnzbd.apiKey,
        output: 'json'
      },
      timeout: 10000
    });
  }
}

async function ensureSabCategory(cfg, categoryName) {
  const name = String(categoryName || '').trim();
  if (!name) return;
  if (!cfg?.sabnzbd?.enabled || !cfg?.sabnzbd?.apiKey) return;

  const sabUrl = getInternalServiceUrl(cfg, 'sabnzbd').replace(/\/$/, '');
  await axios.get(`${sabUrl}/api`, {
    params: {
      mode: 'set_config',
      section: 'categories',
      name,
      apikey: cfg.sabnzbd.apiKey,
      output: 'json'
    },
    timeout: 10000
  });
}

async function ensureSabCategories(cfg, onProgress) {
  if (!cfg?.sabnzbd?.enabled || !cfg?.sabnzbd?.apiKey) return;

  const desired = [cfg?.sabnzbd?.tvCategory, cfg?.sabnzbd?.movieCategory, PROWLARR_SAB_CATEGORY]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const categoryName of new Set(desired)) {
    if (onProgress) onProgress(`Ensuring SABnzbd category exists: ${categoryName}`);
    await ensureSabCategory(cfg, categoryName);
  }
}

function ensureSabHostWhitelist() {
  if (!fs.existsSync(SABNZBD_CONFIG_PATH)) return false;

  const text = fs.readFileSync(SABNZBD_CONFIG_PATH, 'utf8');
  const desiredHosts = ['localhost', '127.0.0.1', '::1', 'sabnzbd', 'sonarr', 'radarr', 'prowlarr', 'wslservarr_ui', 'host.docker.internal'];
  const match = text.match(/^host_whitelist\s*=\s*(.*)$/m);
  const current = new Set(
    String(match?.[1] || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

  let changed = false;
  for (const host of desiredHosts) {
    if (!current.has(host)) {
      current.add(host);
      changed = true;
    }
  }

  if (!changed) return false;

  const updatedLine = `host_whitelist = ${Array.from(current).join(',')}`;
  const nextText = match
    ? text.replace(/^host_whitelist\s*=\s*.*$/m, updatedLine)
    : `${text.trimEnd()}\nhost_whitelist = ${Array.from(current).join(',')}\n`;

  fs.writeFileSync(SABNZBD_CONFIG_PATH, nextText);
  return true;
}

function buildNewznabFields(schemaFields, entry) {
  return (schemaFields || []).map(f => {
    const next = { ...f };
    if (f.name === 'baseUrl' || f.name === 'url') next.value = entry.url;
    if (f.name === 'apiKey') next.value = entry.apiKey;
    if (f.name === 'categories' && Array.isArray(entry.categories) && entry.categories.length) {
      next.value = entry.categories.join(',');
    }
    return next;
  });
}

async function upsertArrProwlarrIndexer(appName, cfg) {
  const arr = appName === 'sonarr' ? cfg.sonarr : cfg.radarr;
  if (!arr?.enabled || !arr?.apiKey) return;
  if (!cfg?.prowlarr?.enabled || !cfg?.prowlarr?.apiKey) return;

  const client = apiClient(getInternalServiceUrl(cfg, appName === 'sonarr' ? 'sonarr' : 'radarr'), arr.apiKey);
  const listRes = await client.get('/api/v3/indexer');
  const existingList = Array.isArray(listRes.data) ? listRes.data : [];
  const stale = existingList.filter((ix) => {
    if (String(ix.name || '').toLowerCase() !== 'prowlarr') return false;
    return String(ix.implementationName || '').toLowerCase() === 'torznab'
      || String(ix.implementationName || '').toLowerCase() === 'newznab';
  });

  for (const ix of stale) {
    if (ix?.id) {
      await client.delete(`/api/v3/indexer/${ix.id}`);
    }
  }
}

function getProwlarrApplicationProfile(appName, cfg) {
  const prowlarrUrl = getInternalServiceUrl(cfg, 'prowlarr').replace(/\/$/, '');
  if (!prowlarrUrl) return null;

  if (appName === 'sonarr') {
    return {
      name: 'Sonarr',
      prowlarrUrl,
      baseUrl: getInternalServiceUrl(cfg, 'sonarr').replace(/\/$/, ''),
      apiKey: cfg?.sonarr?.apiKey || '',
      syncCategories: [5000, 5010, 5020, 5030, 5040, 5045, 5050, 5090],
      animeSyncCategories: [5070]
    };
  }

  if (appName === 'radarr') {
    return {
      name: 'Radarr',
      prowlarrUrl,
      baseUrl: getInternalServiceUrl(cfg, 'radarr').replace(/\/$/, ''),
      apiKey: cfg?.radarr?.apiKey || '',
      syncCategories: [2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060, 2070, 2080, 2090]
    };
  }

  return null;
}

function mapProwlarrApplicationFields(schemaFields, profile) {
  const aliases = {
    prowlarrurl: profile.prowlarrUrl,
    baseurl: profile.baseUrl,
    url: profile.prowlarrUrl,
    apikey: profile.apiKey,
    synccategories: profile.syncCategories,
    animesynccategories: profile.animeSyncCategories
  };

  return (schemaFields || []).map((f) => {
    const next = { ...f };
    const key = String(f.name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(aliases, key)) {
      next.value = aliases[key];
    }
    return next;
  });
}

async function upsertProwlarrApplication(appName, cfg) {
  const profile = getProwlarrApplicationProfile(appName, cfg);
  if (!profile?.prowlarrUrl || !profile?.baseUrl || !profile?.apiKey) return;
  if (!cfg?.prowlarr?.enabled || !cfg?.prowlarr?.apiKey) return;

  const client = apiClient(getInternalServiceUrl(cfg, 'prowlarr'), cfg.prowlarr.apiKey);
  const schemaRes = await client.get('/api/v1/applications/schema');
  const schemaList = Array.isArray(schemaRes.data) ? schemaRes.data : [];
  const schema = schemaList.find(s => String(s.implementationName || '').toLowerCase() === appName);
  if (!schema) throw new Error(`Prowlarr application schema for ${appName} not found`);

  const listRes = await client.get('/api/v1/applications');
  const existingList = Array.isArray(listRes.data) ? listRes.data : [];
  const existing = existingList.find(item => String(item.implementationName || '').toLowerCase() === appName);

  const fields = mapProwlarrApplicationFields(schema.fields, profile);
  const payload = {
    ...(existing || {}),
    enable: true,
    name: profile.name,
    syncLevel: 'fullSync',
    implementation: schema.implementation,
    implementationName: schema.implementationName,
    configContract: schema.configContract,
    fields,
    tags: existing?.tags || []
  };

  if (existing?.id) {
    await client.put(`/api/v1/applications/${existing.id}`, payload);
  } else {
    await client.post('/api/v1/applications', payload);
  }
}

async function applyIntegrationsWithProgress(cfg, appName = null, onProgress) {
  const appTargets = appName && ['sonarr', 'radarr'].includes(appName)
    ? [appName]
    : ['sonarr', 'radarr'];

  if (cfg.newshosting?.enabled) {
    if (onProgress) onProgress('Applying Newshosting server to SABnzbd...');
    try {
      await retryAsync(() => upsertSabNewshostingServer(cfg), 8, 2500);
    } catch (e) {
      if (onProgress) onProgress(`Warning: SAB Newshosting auto-config skipped: ${e.message}`);
    }
  }

  for (const app of appTargets) {
    const arrCfg = cfg[app];
    if (!arrCfg?.enabled || !arrCfg?.apiKey) {
      if (onProgress) onProgress(`Skipping ${app} auto-config (app disabled or API key missing).`);
      continue;
    }

    if (onProgress) onProgress(`Applying ${app} root folder...`);
    try {
      await retryAsync(() => ensureRootFolder(app, cfg), 8, 2500);
    } catch (e) {
      if (onProgress) onProgress(`Warning: ${app} root folder setup skipped: ${e.message}`);
    }

    if (cfg.prowlarr?.enabled && cfg.prowlarr?.apiKey) {
      if (onProgress) onProgress(`Applying Prowlarr application for ${app}...`);
      await retryAsync(() => upsertProwlarrApplication(app, cfg), 8, 2500);

      if (onProgress) onProgress(`Applying Prowlarr indexer in ${app}...`);
      await retryAsync(() => upsertArrProwlarrIndexer(app, cfg), 8, 2500);
    } else if (onProgress) {
      onProgress(`Skipping ${app} Prowlarr application setup (Prowlarr disabled or API key missing).`);
    }

    if (cfg.sabnzbd?.enabled && cfg.sabnzbd?.apiKey) {
      if (onProgress) onProgress(`Applying ${app} download client (SABnzbd)...`);
      try {
        await retryAsync(() => upsertArrDownloadClient(app, cfg), 8, 2500);
      } catch (e) {
        if (onProgress) onProgress(`Warning: ${app} SAB downloader setup skipped: ${e.message}`);
      }
    } else if (onProgress) {
      onProgress(`Skipping ${app} SABnzbd downloader setup (SAB disabled or API key missing).`);
    }
  }
}

async function autoConfigureProwlarrApplications(cfg, onProgress) {
  if (!cfg?.prowlarr?.enabled || !cfg?.prowlarr?.apiKey) return;

  const appTargets = ['sonarr', 'radarr'];
  for (const app of appTargets) {
    const arrCfg = cfg[app];
    if (!arrCfg?.enabled || !arrCfg?.apiKey) {
      if (onProgress) onProgress(`Skipping Prowlarr application auto-config for ${app} (disabled or API key missing).`);
      continue;
    }

    if (onProgress) onProgress(`Auto-configuring Prowlarr application for ${app}...`);
    await retryAsync(() => upsertProwlarrApplication(app, cfg), 8, 2500);
  }

  await retryAsync(() => triggerProwlarrAppIndexerSync(cfg, onProgress, true), 8, 2500);
}

async function waitForAppReady(appName, cfg, onProgress) {
  if (!appName || !cfg?.[appName]?.enabled) return;

  const checks = {
    sonarr: async () => testArr(getInternalServiceUrl(cfg, 'sonarr'), cfg.sonarr.apiKey),
    radarr: async () => testArr(getInternalServiceUrl(cfg, 'radarr'), cfg.radarr.apiKey),
    prowlarr: async () => testProwlarr(getInternalServiceUrl(cfg, 'prowlarr'), cfg.prowlarr.apiKey),
    sabnzbd: async () => testSab(getInternalServiceUrl(cfg, 'sabnzbd'), cfg.sabnzbd.apiKey)
  };

  const check = checks[appName];
  if (!check) return;

  const hasApiKey = !!cfg?.[appName]?.apiKey;
  if (!hasApiKey) return;

  if (onProgress) onProgress(`Waiting for ${appName} API to become ready...`);
  await retryAsync(check, 24, 2500);
}

async function relinkAppsWithProgress(appName = null, onProgress) {
  const cfg = await syncEnabledAppsFromContainers(readEffectiveConfig({ persist: true }));

  if (cfg?.sabnzbd?.enabled) {
    const sabUpdated = ensureSabHostWhitelist();
    if (sabUpdated) {
      if (onProgress) onProgress('Updated SABnzbd host whitelist for container-to-container access. Restarting SABnzbd...');
      await docker.getContainer('sabnzbd').restart();
    }
  }

  if (appName) {
    await waitForAppReady(appName, cfg, onProgress);
  }

  if (cfg?.prowlarr?.enabled && cfg?.prowlarr?.apiKey) {
    await waitForAppReady('prowlarr', cfg, onProgress);
  }

  if (cfg?.sabnzbd?.enabled && cfg?.sabnzbd?.apiKey && cfg?.newshosting?.enabled) {
    await waitForAppReady('sabnzbd', cfg, onProgress);
  }

  if (cfg?.sabnzbd?.enabled && cfg?.sabnzbd?.apiKey) {
    await ensureSabDownloadDirectories(cfg, onProgress);
    await ensureSabCategories(cfg, onProgress);
  }

  if (cfg?.prowlarr?.enabled && cfg?.prowlarr?.apiKey && cfg?.sabnzbd?.enabled && cfg?.sabnzbd?.apiKey) {
    if (onProgress) onProgress('Linking SABnzbd in Prowlarr...');
    await upsertProwlarrDownloadClient(cfg);
  }

  if (onProgress) onProgress('Relinking deployed app integrations...');
  await applyIntegrationsWithProgress(cfg, appName, onProgress);

  if (cfg?.prowlarr?.enabled && cfg?.prowlarr?.apiKey) {
    if (onProgress) onProgress('Triggering Prowlarr indexer sync for linked apps...');
    await triggerProwlarrAppIndexerSync(cfg, onProgress, true);
  } else if (onProgress) {
    onProgress('Skipping Prowlarr relink (Prowlarr disabled or API key missing).');
  }

  return cfg;
}

async function triggerProwlarrAppIndexerSync(cfg, onProgress, forceSync = true) {
  if (!cfg?.prowlarr?.enabled || !cfg?.prowlarr?.apiKey) return;

  const client = apiClient(getInternalServiceUrl(cfg, 'prowlarr'), cfg.prowlarr.apiKey);
  let indexers = [];
  try {
    const list = await client.get('/api/v1/indexer');
    indexers = Array.isArray(list.data) ? list.data : [];
  } catch {
    indexers = [];
  }

  const enabledIndexerCount = indexers.filter((ix) => ix?.enable !== false).length;
  if (enabledIndexerCount === 0) {
    if (onProgress) onProgress('Skipping Prowlarr app indexer sync because no Prowlarr indexers are configured yet.');
    return;
  }

  if (onProgress) onProgress('Triggering Prowlarr app indexer sync...');
  const res = await client.post('/api/v1/command', {
    name: 'ApplicationIndexerSync',
    forceSync: !!forceSync
  });

  if (res?.data?.id && onProgress) {
    onProgress(`Queued Prowlarr app indexer sync command #${res.data.id}.`);
  }
}

async function ensureRootFolder(appName, cfg) {
  const arr = appName === 'sonarr' ? cfg.sonarr : cfg.radarr;
  const rootPath = appName === 'sonarr' ? arr.tvRoot : arr.movieRoot;

  if (typeof rootPath === 'string' && rootPath.trim()) {
    const trimmed = rootPath.trim();
    let hostPath = trimmed;
    if (trimmed === '/media' || trimmed.startsWith('/media/')) {
      hostPath = `/mnt/media${trimmed.slice('/media'.length)}`;
    } else if (trimmed === '/downloads' || trimmed.startsWith('/downloads/')) {
      hostPath = `/mnt/downloads${trimmed.slice('/downloads'.length)}`;
    }
    try {
      fs.mkdirSync(hostPath, { recursive: true });
    } catch {
      // ignore local fs mkdir errors and let Arr API validation report if needed
    }
  }
  
  const client = apiClient(getInternalServiceUrl(cfg, appName === 'sonarr' ? 'sonarr' : 'radarr'), arr.apiKey);
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

async function syncEnabledAppsFromContainers(cfg) {
  const all = await withTimeout(docker.listContainers({ all: true }), 4000, 'docker.listContainers');
  const present = new Set();

  for (const container of all) {
    for (const rawName of container.Names || []) {
      present.add(String(rawName || '').replace(/^\//, ''));
    }
  }

  let changed = false;
  for (const name of TARGET_CONTAINERS) {
    if (present.has(name) && cfg?.[name] && !cfg[name].enabled) {
      cfg[name].enabled = true;
      changed = true;
    }
  }

  if (changed) {
    writeConfig(cfg);
  }

  return cfg;
}

function normalizeConfig(config) {
  const next = { ...config };
  next.sonarr = next.sonarr || { enabled: false, url: 'http://sonarr:8989', apiKey: '', port: '8989', tvRoot: '/media/tv' };
  next.radarr = next.radarr || { enabled: false, url: 'http://radarr:7878', apiKey: '', port: '7878', movieRoot: '/media/movies' };
  next.sabnzbd = next.sabnzbd || { enabled: false, url: 'http://sabnzbd:8080', apiKey: '', port: '8080', tvCategory: 'tv', movieCategory: 'movies' };
  next.prowlarr = next.prowlarr || { enabled: false, url: 'http://prowlarr:9696', apiKey: '', port: '9696' };
  next.jellyfin = next.jellyfin || { enabled: false, url: 'http://jellyfin:8096', apiKey: '', port: '8096' };
  next.newshosting = next.newshosting || {
    enabled: false,
    name: 'newshosting',
    host: 'news.newshosting.com',
    port: 563,
    username: '',
    password: '',
    ssl: true,
    connections: 40,
    retention: 0,
    optional: false
  };
  if (next.indexers && !Array.isArray(next.indexers)) next.indexers = [];
  next.paths = next.paths || { mediaRoot: '/mnt/media', downloadsRoot: '/mnt/downloads' };
  if (typeof next.sonarr.tvRoot === 'string' && next.sonarr.tvRoot.startsWith('/mnt/media')) {
    next.sonarr.tvRoot = next.sonarr.tvRoot.replace('/mnt/media', '/media');
  }
  if (!next.sonarr.tvRoot) next.sonarr.tvRoot = '/media/tv';
  if (typeof next.radarr.movieRoot === 'string' && next.radarr.movieRoot.startsWith('/mnt/media')) {
    next.radarr.movieRoot = next.radarr.movieRoot.replace('/mnt/media', '/media');
  }
  if (!next.radarr.movieRoot) next.radarr.movieRoot = '/media/movies';

  next.sonarr.url = normalizeAppServiceUrl('sonarr', next.sonarr.url, next.sonarr.port || 8989);
  next.radarr.url = normalizeAppServiceUrl('radarr', next.radarr.url, next.radarr.port || 7878);
  next.sabnzbd.url = normalizeAppServiceUrl('sabnzbd', next.sabnzbd.url, next.sabnzbd.port || 8080);
  next.prowlarr.url = normalizeAppServiceUrl('prowlarr', next.prowlarr.url, next.prowlarr.port || 9696);
  next.jellyfin.url = normalizeAppServiceUrl('jellyfin', next.jellyfin.url, next.jellyfin.port || 8096);

  next.runtime = next.runtime || {};
  next.runtime.timezone = next.runtime.timezone || 'America/New_York';
  next.runtime.puid = String(next.runtime.puid || '1000');
  next.runtime.pgid = String(next.runtime.pgid || '1000');
  for (const appName of TARGET_CONTAINERS) {
    next[appName].composeYaml = typeof next[appName].composeYaml === 'string' ? next[appName].composeYaml : '';
  }
  next.setup = next.setup || {};
  next.setup.completed = Boolean(next.setup.completed);
  next.setup.completedAt = next.setup.completedAt || null;
  next.composeYaml = typeof next.composeYaml === 'string' ? next.composeYaml : '';
  for (const appName of TARGET_CONTAINERS) {
    let yaml = next[appName].composeYaml || '';
    // Clean up stored YAML: remove any networks: entries that shouldn't be there
    if (yaml.trim()) {
      yaml = yaml.split('\n')
        .filter((line) => !line.trim().startsWith('networks:'))
        .filter((line) => !/^-\s*["']?wslservarr["']?\s*$/i.test(line.trim()))
        .join('\n')
        .trimEnd();
    }
    // Regenerate if empty or invalid
    if (!yaml.trim() || !hasServiceYamlBody(appName, yaml)) {
      yaml = getDefaultServiceYaml(next, appName);
    }
    next[appName].composeYaml = yaml;
  }
  next.composeYaml = buildComposeFromIndependentYaml(next);
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
      tvRoot: body.tvRoot || '/media/tv',
      composeYaml: typeof body.sonarrComposeYaml === 'string' ? body.sonarrComposeYaml : (prev.sonarr.composeYaml || '')
    },
    radarr: {
      enabled: body.radarrEnabled === 'on' || body.radarrEnabled === true,
      url: body.radarrUrl || prev.radarr.url || 'http://radarr:7878',
      apiKey: body.radarrApiKey || '',
      port: body.radarrPort || '7878',
      movieRoot: body.movieRoot || '/media/movies',
      composeYaml: typeof body.radarrComposeYaml === 'string' ? body.radarrComposeYaml : (prev.radarr.composeYaml || '')
    },
    sabnzbd: {
      enabled: body.sabnzbdEnabled === 'on' || body.sabnzbdEnabled === true,
      url: body.sabUrl || prev.sabnzbd.url || 'http://sabnzbd:8080',
      apiKey: body.sabApiKey || '',
      port: body.sabPort || '8080',
      tvCategory: body.tvCategory || 'tv',
      movieCategory: body.movieCategory || 'movies',
      composeYaml: typeof body.sabnzbdComposeYaml === 'string' ? body.sabnzbdComposeYaml : (prev.sabnzbd.composeYaml || '')
    },
    prowlarr: {
      enabled: body.prowlarrEnabled === 'on' || body.prowlarrEnabled === true,
      url: body.prowlarrUrl || prev.prowlarr.url || 'http://prowlarr:9696',
      apiKey: body.prowlarrApiKey || '',
      port: body.prowlarrPort || '9696',
      composeYaml: typeof body.prowlarrComposeYaml === 'string' ? body.prowlarrComposeYaml : (prev.prowlarr.composeYaml || '')
    },
    jellyfin: {
      enabled: body.jellyfinEnabled === 'on' || body.jellyfinEnabled === true,
      url: body.jellyfinUrl || prev.jellyfin.url || 'http://jellyfin:8096',
      apiKey: body.jellyfinApiKey || '',
      port: body.jellyfinPort || '8096',
      composeYaml: typeof body.jellyfinComposeYaml === 'string' ? body.jellyfinComposeYaml : (prev.jellyfin.composeYaml || '')
    },
    newshosting: {
      enabled: body.newshostingEnabled === 'on' || body.newshostingEnabled === true,
      name: body.newshostingName || prev.newshosting.name || 'newshosting',
      host: body.newshostingHost || prev.newshosting.host || 'news.newshosting.com',
      port: body.newshostingPort || prev.newshosting.port || 563,
      username: body.newshostingUsername || prev.newshosting.username || '',
      password: body.newshostingPassword || prev.newshosting.password || '',
      ssl: body.newshostingSsl === true || body.newshostingSsl === 'on',
      connections: body.newshostingConnections || prev.newshosting.connections || 40,
      retention: body.newshostingRetention || prev.newshosting.retention || 0,
      optional: body.newshostingOptional === true || body.newshostingOptional === 'on'
    },
    indexers: Array.isArray(prev.indexers) ? prev.indexers : [],
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
  next.composeYaml = buildComposeFromIndependentYaml(next);
  return next;
}

async function getDashboardData() {
  const config = mergeDiscoveredApiKeys(readConfig());
  let containers = [];
  try {
    containers = await getContainerStatuses();
  } catch (e) {
    containers = TARGET_CONTAINERS.map(name => ({ name, status: `error: ${e.message}` }));
  }
  return { config, containers };
}


function buildAppsCompose(cfg) {
  const tz = cfg.runtime.timezone;
  const puid = cfg.runtime.puid;
  const pgid = cfg.runtime.pgid;
  const mediaRoot = cfg.paths.mediaRoot || '/mnt/media';
  const downloadsRoot = cfg.paths.downloadsRoot || '/mnt/downloads';

  let compose = 'services:\n';
  const sharedNetworkBlock = `\nnetworks:\n  ${SHARED_DOCKER_NETWORK}:\n    external: true\n    name: ${SHARED_DOCKER_NETWORK}\n`;

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
      - ${mediaRoot}:/media
      - ${downloadsRoot}:/downloads
    ports:
      - "0.0.0.0:${cfg.sabnzbd.port}:8080"
    restart: unless-stopped

`;
  }

  if (cfg.sonarr.enabled) {
    compose += `  sonarr:
    image: lscr.io/linuxserver/sonarr:4.0.17.2952-ls313
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
      - "0.0.0.0:${cfg.sonarr.port}:8989"
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
      - "0.0.0.0:${cfg.radarr.port}:7878"
    restart: unless-stopped

`;
  }

  if (cfg.prowlarr.enabled) {
    compose += `  prowlarr:
    image: lscr.io/linuxserver/prowlarr:latest
    container_name: prowlarr
    environment:
      - PUID=${puid}
      - PGID=${pgid}
      - TZ=${tz}
    volumes:
      - /mnt/config/prowlarr:/config
    ports:
      - "0.0.0.0:${cfg.prowlarr.port}:9696"
    restart: unless-stopped

`;
  }

  if (cfg.jellyfin.enabled) {
    compose += `  jellyfin:
    image: lscr.io/linuxserver/jellyfin:latest
    container_name: jellyfin
    environment:
      - PUID=${puid}
      - PGID=${pgid}
      - TZ=${tz}
    volumes:
      - /mnt/config/jellyfin:/config
      - ${mediaRoot}:/media
    ports:
      - "0.0.0.0:${cfg.jellyfin.port}:8096"
    restart: unless-stopped

`;
  }

  return `${compose}${sharedNetworkBlock}`;
}

function extractServiceYaml(composeYaml, appName) {
  const text = String(composeYaml || '');
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.trim() === `${appName}:` && line.startsWith('  '));
  if (start === -1) return '';

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop when we hit:
    // 1. Another service (2+ spaces + key:) 
    // 2. A top-level key (0 spaces + key:)
    // But NOT a blank line (even with whitespace)
    if (line.trim()) {  // Non-empty line
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(line) || /^[A-Za-z0-9_-]+:\s*$/.test(line)) {
        end = i;
        break;
      }
    }
  }

  return lines.slice(start, end).join('\n').trimEnd();
}

function normalizeServiceYamlBlock(appName, serviceYaml) {
  let raw = String(serviceYaml || '').trimEnd();
  const extracted = extractServiceYaml(raw, appName);
  if (extracted) {
    raw = extracted;
  }

  const strippedLines = [];
  const lines = raw.split('\n');
  let skipSectionIndent = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    const indent = (line.match(/^\s*/)?.[0]?.length) || 0;

    if (skipSectionIndent >= 0) {
      if (!trimmed) {
        continue;
      }
      if (indent > skipSectionIndent) {
        continue;
      }
      skipSectionIndent = -1;
    }

    if (/^networks:\s*$/i.test(trimmed)) {
      skipSectionIndent = indent;
      continue;
    }

    if (/^-\s*["']?wslservarr["']?\s*$/i.test(trimmed)) {
      continue;
    }

    strippedLines.push(line);
  }

  return strippedLines
    .map((line, idx) => {
      if (idx === 0) {
        if (line.trim() === `${appName}:`) return `  ${appName}:`;
        if (line.trim().endsWith(':')) return `  ${line.trim()}`;
        return `  ${appName}:`;
      }
      if (!line.trim()) return '';
      return line.startsWith('  ') ? line : `    ${line.trimStart()}`;
    })
    .join('\n')
    .replace(/\n\s*\n+/g, '\n') // Remove multiple consecutive empty lines
    .trimEnd();
}

function ensureRequiredServiceYamlMounts(cfg, appName, serviceYaml) {
  let normalized = normalizeServiceYamlBlock(appName, serviceYaml);

  if (appName === 'sabnzbd') {
    const mediaRoot = cfg?.paths?.mediaRoot || '/mnt/media';
    if (!normalized.includes(':/media')) {
      const lines = normalized.split('\n');
      const insertIndex = lines.findIndex((line) => line.trim() === '- /mnt/downloads:/downloads' || line.trim().endsWith(':/downloads'));
      const mountLine = `      - ${mediaRoot}:/media`;

      if (insertIndex >= 0) {
        lines.splice(insertIndex, 0, mountLine);
      } else {
        const volumesIndex = lines.findIndex((line) => line.trim() === 'volumes:');
        if (volumesIndex >= 0) {
          lines.splice(volumesIndex + 1, 0, mountLine);
        }
      }

      normalized = lines.join('\n');
    }
  }

  return normalized;
}

function hasServiceYamlBody(appName, serviceYaml) {
  const normalized = normalizeServiceYamlBlock(appName, serviceYaml);
  const lines = normalized.split('\n');
  return lines.slice(1).some((line) => /^\s{4}\S/.test(line));
}

function getDefaultServiceYaml(cfg, appName) {
  const cfgWithAppEnabled = {
    ...cfg,
    [appName]: {
      ...(cfg?.[appName] || {}),
      enabled: true
    }
  };

  const extracted = extractServiceYaml(buildAppsCompose(cfgWithAppEnabled), appName);
  return normalizeServiceYamlBlock(appName, extracted);
}

function getAppServiceYaml(cfg, appName) {
  const raw = String(cfg?.[appName]?.composeYaml || '').trim();
  if (raw && hasServiceYamlBody(appName, raw)) {
    return ensureRequiredServiceYamlMounts(cfg, appName, raw);
  }
  return ensureRequiredServiceYamlMounts(cfg, appName, getDefaultServiceYaml(cfg, appName));
}

function buildComposeFromIndependentYaml(cfg, appNames = TARGET_CONTAINERS.filter((name) => cfg[name]?.enabled)) {
  const blocks = appNames
    .filter((name) => TARGET_CONTAINERS.includes(name))
    .map((name) => ({ name, block: getAppServiceYaml(cfg, name) }))
    .filter((entry) => Boolean(entry.block))
    .map((entry) => normalizeServiceYamlBlock(entry.name, entry.block));

  if (!blocks.length) {
    return `services:\n\nnetworks:\n  ${SHARED_DOCKER_NETWORK}:\n    external: true\n    name: ${SHARED_DOCKER_NETWORK}\n`;
  }

  return `services:\n${blocks.map((block) => `${block}\n`).join('')}\nnetworks:\n  ${SHARED_DOCKER_NETWORK}:\n    external: true\n    name: ${SHARED_DOCKER_NETWORK}\n`;
}

function upsertServiceYaml(composeYaml, appName, serviceYaml) {
  const base = String(composeYaml || '').trim() || 'services:\n';
  const lines = base.split('\n');

  const normalizedBlock = normalizeServiceYamlBlock(appName, serviceYaml);

  const hasServices = lines.some(line => line.trim() === 'services:');
  if (!hasServices) {
    return `services:\n${normalizedBlock}\n`;
  }

  const start = lines.findIndex(line => line.trim() === `${appName}:` && line.startsWith('  '));
  if (start === -1) {
    const out = `${base.trimEnd()}\n${normalizedBlock}\n`;
    return out;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const updated = [...lines.slice(0, start), ...normalizedBlock.split('\n'), ...lines.slice(end)];
  return `${updated.join('\n').trimEnd()}\n`;
}

function syncAppConfigFromServiceYaml(cfg, appName, serviceYaml) {
  const text = String(serviceYaml || '');
  const portMatch = text.match(/-\s*"?(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d+):(\d+)(?:\/\w+)?"?/);
  if (portMatch && cfg[appName]) {
    cfg[appName].port = portMatch[1];
  }
  return cfg;
}

function applyComposeHotfixes(composeYaml) {
  return String(composeYaml || '').replace(
    'lscr.io/linuxserver/sonarr:latest',
    'lscr.io/linuxserver/sonarr:4.0.17.2952-ls313'
  );
}

async function installOrUpdateSingleAppWithProgress(config, appName, onProgress) {
  const cfg = normalizeConfig(config);
  if (!TARGET_CONTAINERS.includes(appName)) {
    throw new Error(`Unknown app: ${appName}`);
  }

  const dirs = ['/srv/config/sonarr', '/srv/config/radarr', '/srv/config/sabnzbd', '/srv/config/prowlarr', '/srv/config/jellyfin', '/srv/downloads', '/srv/media'];
  if (onProgress) onProgress(`Preparing directories for ${appName}...`);
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }

  if (!cfg[appName]?.enabled) {
    cfg[appName].enabled = true;
    if (onProgress) onProgress(`${appName} was disabled in config, enabling for deployment.`);
    writeConfig(cfg);
  }

  await ensureSharedDockerNetwork();

  const composeYaml = buildComposeFromIndependentYaml(cfg, [appName]);

  fs.writeFileSync(APPS_COMPOSE_PATH, applyComposeHotfixes(composeYaml));
  if (onProgress) onProgress(`Wrote compose file: ${APPS_COMPOSE_PATH}`);

  if (onProgress) onProgress(`Pulling image for ${appName}...`);
  await runCommandWithProgress('docker', ['compose', '-f', APPS_COMPOSE_PATH, 'pull', appName], `pull:${appName}`, onProgress);

  if (onProgress) onProgress(`Starting ${appName}...`);
  await runCommandWithProgress('docker', ['compose', '-f', APPS_COMPOSE_PATH, 'up', '-d', appName], `up:${appName}`, onProgress);

  if (onProgress) onProgress(`${appName} deployment completed.`);
}

async function restartAppsWithProgress(config, appName = null, onProgress) {
  const cfg = normalizeConfig(config);
  const appNames = appName
    ? [appName]
    : TARGET_CONTAINERS.filter((name) => cfg[name]?.enabled);

  if (!appNames.length) {
    throw new Error('No enabled apps available to restart.');
  }

  if (appName && !TARGET_CONTAINERS.includes(appName)) {
    throw new Error(`Unknown app: ${appName}`);
  }

  if (appName && !cfg[appName]?.enabled) {
    cfg[appName].enabled = true;
    if (onProgress) onProgress(`${appName} was disabled in config, enabling for restart.`);
    writeConfig(cfg);
  }

  await ensureSharedDockerNetwork();

  const composeYaml = buildComposeFromIndependentYaml(cfg, appNames);
  fs.writeFileSync(APPS_COMPOSE_PATH, applyComposeHotfixes(composeYaml));
  if (onProgress) onProgress(`Wrote compose file: ${APPS_COMPOSE_PATH}`);

  for (const name of appNames) {
    if (onProgress) onProgress(`Recreating ${name}...`);
    await runCommandWithProgress(
      'docker',
      ['compose', '-f', APPS_COMPOSE_PATH, 'up', '-d', '--force-recreate', '--no-deps', name],
      `restart:${name}`,
      onProgress
    );
  }

  if (onProgress) onProgress('Restart completed.');
}

function startOperationJob(operation, config, appName = null) {
  if (deployState.running) {
    throw new Error(`A ${deployState.operation || 'deployment'} is already in progress.`);
  }

  setDeployState({
    running: true,
    operation,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    success: null,
    error: '',
    logs: []
  });
  pushDeployLog(appName ? `${operation === 'restart' ? 'Restart' : 'Deployment'} started for ${appName}...` : `${operation === 'restart' ? 'Restart' : 'Deployment'} started...`);

  (async () => {
    try {
      const cfg = normalizeConfig(config);
      if (operation === 'restart') {
        await restartAppsWithProgress(cfg, appName, pushDeployLog);
        pushDeployLog('Running automatic post-restart app relink...');
        await relinkAppsWithProgress(appName, pushDeployLog);
      } else if (appName) {
        await installOrUpdateSingleAppWithProgress(cfg, appName, pushDeployLog);

        pushDeployLog('Running automatic post-deploy app relink...');
        await relinkAppsWithProgress(appName, pushDeployLog);
      } else {
        throw new Error(`Unsupported operation: ${operation}`);
      }

      setDeployState({
        running: false,
        operation,
        finishedAt: new Date().toISOString(),
        success: true,
        error: ''
      });
      emitDeployEvent('done', { state: deployState });
    } catch (e) {
      pushDeployLog(`ERROR: ${e.message}`);
      setDeployState({
        running: false,
        operation,
        finishedAt: new Date().toISOString(),
        success: false,
        error: e.message
      });
      emitDeployEvent('done', { state: deployState });
    }
  })();
}

function startDeployJob(config, appName) {
  if (!TARGET_CONTAINERS.includes(appName)) {
    throw new Error(`Unknown app: ${appName}`);
  }

  startOperationJob('deploy', config, appName);
}

function startRestartJob(config, appName = null) {
  if (appName && !TARGET_CONTAINERS.includes(appName)) {
    throw new Error(`Unknown app: ${appName}`);
  }

  startOperationJob('restart', config, appName);
}

function sendSpa(res) {
  res.sendFile(path.join(SPA_DIST_PATH, 'index.html'));
}

app.get('/wizard', async (req, res) => {
  return res.redirect('/');
});

app.get('/', async (req, res) => {
  return sendSpa(res);
});

app.get('/api/bootstrap', async (req, res) => {
  const data = await getDashboardData();
  res.json({
    ok: true,
    ...data
  });
});

app.get('/api/containers', async (req, res) => {
  try {
    const containers = await getContainerStatuses();
    return res.json({ ok: true, containers });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
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

app.post('/api/discover-keys', (req, res) => {
  try {
    const found = discoverApiKeysFromMountedConfig();

    const cfg = mergeDiscoveredApiKeys(readConfig(), found);

    writeConfig(cfg);

    const discoveredApps = Object.keys(found);
    const message = discoveredApps.length
      ? `Discovered API keys for: ${discoveredApps.join(', ')}`
      : 'No API keys discovered from mounted app configs.';

    res.json({ ok: true, found, config: cfg, message });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/compose', (req, res) => {
  try {
    const cfg = readEffectiveConfig({ persist: true });
    cfg.composeYaml = typeof req.body.composeYaml === 'string' ? req.body.composeYaml : cfg.composeYaml;
    writeConfig(cfg);
    res.json({ ok: true, composeYaml: cfg.composeYaml });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/yaml/:appName', (req, res) => {
  const appName = req.params.appName;
  if (!TARGET_CONTAINERS.includes(appName)) {
    return res.status(400).json({ ok: false, error: 'Unknown app' });
  }

  const cfg = readEffectiveConfig({ persist: true });
  const serviceYaml = getAppServiceYaml(cfg, appName);

  return res.json({ ok: true, appName, serviceYaml });
});

app.post('/api/yaml/:appName', (req, res) => {
  try {
    const appName = req.params.appName;
    if (!TARGET_CONTAINERS.includes(appName)) {
      return res.status(400).json({ ok: false, error: 'Unknown app' });
    }

    const raw = req.body?.serviceYaml;
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ ok: false, error: 'serviceYaml is required' });
    }

    const cfg = readEffectiveConfig({ persist: true });
    cfg[appName].composeYaml = ensureRequiredServiceYamlMounts(cfg, appName, raw);
    syncAppConfigFromServiceYaml(cfg, appName, cfg[appName].composeYaml);
    cfg.composeYaml = buildComposeFromIndependentYaml(cfg);
    writeConfig(cfg);

    return res.json({ ok: true, appName, serviceYaml: cfg[appName].composeYaml, config: cfg });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/test/:appName', async (req, res) => {
  try {
    const cfg = readEffectiveConfig({ persist: true });
    const appName = req.params.appName;
    if (appName === 'sonarr') await testArr(cfg.sonarr.url, cfg.sonarr.apiKey);
    else if (appName === 'radarr') await testArr(cfg.radarr.url, cfg.radarr.apiKey);
    else if (appName === 'sabnzbd') await testSab(cfg.sabnzbd.url, cfg.sabnzbd.apiKey);
    else if (appName === 'prowlarr') await testProwlarr(cfg.prowlarr.url, cfg.prowlarr.apiKey);
    else if (appName === 'jellyfin') await testJellyfin(cfg.jellyfin.url, cfg.jellyfin.apiKey);
    else throw new Error('Unknown app');

    res.json({ ok: true, message: `${appName} connection OK` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/apply', async (req, res) => {
  try {
    await relinkAppsWithProgress(null, pushDeployLog);
    res.json({ ok: true, message: 'Relinked deployed apps and refreshed Prowlarr/SAB/Arr integration.' });
  } catch (e) {
    const upstreamStatus = e?.response?.status;
    const upstreamData = e?.response?.data;
    const detail = upstreamStatus
      ? ` (upstream ${upstreamStatus}${upstreamData ? `: ${typeof upstreamData === 'string' ? upstreamData : JSON.stringify(upstreamData)}` : ''})`
      : '';
    res.status(500).json({ ok: false, error: `Apply failed: ${e.message}${detail}` });
  }
});

app.post('/api/install/apps/:appName/start', (req, res) => {
  try {
    const appName = req.params.appName;
    if (!TARGET_CONTAINERS.includes(appName)) {
      return res.status(400).json({ ok: false, error: 'Unknown app', state: deployState });
    }

    const cfg = readEffectiveConfig({ persist: true });
    startDeployJob(cfg, appName);
    return res.json({ ok: true, state: deployState });
  } catch (e) {
    return res.status(409).json({ ok: false, error: e.message, state: deployState });
  }
});

app.post('/api/install/apps/restart', (req, res) => {
  try {
    const cfg = readEffectiveConfig({ persist: true });
    startRestartJob(cfg);
    return res.json({ ok: true, state: deployState });
  } catch (e) {
    return res.status(409).json({ ok: false, error: e.message, state: deployState });
  }
});

app.post('/api/install/apps/:appName/restart', (req, res) => {
  try {
    const appName = req.params.appName;
    if (!TARGET_CONTAINERS.includes(appName)) {
      return res.status(400).json({ ok: false, error: 'Unknown app', state: deployState });
    }

    const cfg = readEffectiveConfig({ persist: true });
    startRestartJob(cfg, appName);
    return res.json({ ok: true, state: deployState });
  } catch (e) {
    return res.status(409).json({ ok: false, error: e.message, state: deployState });
  }
});

app.get('/api/diagnostics/:appName', async (req, res) => {
  try {
    const appName = req.params.appName;
    if (!TARGET_CONTAINERS.includes(appName)) {
      return res.status(400).json({ ok: false, error: 'Unknown app' });
    }

    const report = await captureDiagnostics(appName);
    return res.json({ ok: true, ...report });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/diagnostics/:appName/history', (req, res) => {
  try {
    const appName = req.params.appName;
    if (!TARGET_CONTAINERS.includes(appName)) {
      return res.status(400).json({ ok: false, error: 'Unknown app' });
    }
    ensureDiagnosticsDir();
    const files = fs.readdirSync(DIAGNOSTICS_DIR)
      .filter(name => name.startsWith(`${appName}-`) && name.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, 20)
      .map(name => ({ name, path: path.join(DIAGNOSTICS_DIR, name) }));
    return res.json({ ok: true, files });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/install/apps/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  deployClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'snapshot', state: deployState })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    deployClients.delete(res);
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/container')) {
    return next();
  }
  return sendSpa(res);
});

app.post('/container/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  if (!TARGET_CONTAINERS.includes(name)) {
    return res.status(400).json({ error: 'Invalid container' });
  }

  try {
    if (action === 'start' || action === 'restart') {
      const cfg = readEffectiveConfig({ persist: true });
      if (!cfg[name]?.enabled) {
        cfg[name].enabled = true;
        writeConfig(cfg);
      }

      await ensureSharedDockerNetwork();

      const composeYaml = buildComposeFromIndependentYaml(cfg, [name]);
      fs.writeFileSync(APPS_COMPOSE_PATH, applyComposeHotfixes(composeYaml));

      const args = ['compose', '-f', APPS_COMPOSE_PATH, 'up', '-d'];
      if (action === 'restart') {
        args.push('--force-recreate');
      }
      args.push(name);
      await execFileAsync('docker', args, {
        env: {
          ...process.env,
          COMPOSE_IGNORE_ORPHANS: 'true'
        }
      });

      const targetApp = ['sonarr', 'radarr'].includes(name) ? name : null;
      if (['prowlarr', 'sonarr', 'radarr', 'sabnzbd'].includes(name)) {
        await relinkAppsWithProgress(targetApp);
      }
    } else if (action === 'stop') {
      const container = docker.getContainer(name);
      await container.stop();
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  ensureConfig();
  console.log(`wslservarr-ui listening on ${PORT}`);

  setTimeout(() => {
    try {
      const cfg = readEffectiveConfig({ persist: true });
      autoConfigureProwlarrApplications(cfg).catch((e) => {
        console.warn(`Prowlarr auto-config failed: ${e.message}`);
      });
    } catch (e) {
      console.warn(`Prowlarr auto-config skipped: ${e.message}`);
    }
  }, 5000);
});

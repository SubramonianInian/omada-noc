const express = require('express');
const axios = require('axios');
const https = require('https');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3737', 10);
const app = express();

// Security headers
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Disable caching for API routes
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// Ignore self-signed SSL certs from Omada controller
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// The Omada API answers HTTP 200 even when a call fails - the real status
// lives in body.errorCode (0 = success). axios only rejects on non-2xx, so
// without this every failure looked like a success with an undefined result.
function unwrap(resp, what) {
  const data = resp && resp.data;
  if (!data || typeof data.errorCode === 'undefined') {
    throw new Error(`${what}: unexpected response from controller`);
  }
  if (data.errorCode !== 0) {
    const err = new Error(data.msg || `${what} failed`);
    err.errorCode = data.errorCode;
    throw err;
  }
  return data.result;
}

let sessionData = {
  token: null,
  cookies: null,
  baseUrl: null,
  controllerId: null,
  siteId: null,
};

// Traffic history buffer (60 points = 30 min at 30s intervals)
const TRAFFIC_HISTORY_SIZE = 60;
const POLL_INTERVAL_SEC = 30;
const trafficHistory = { timestamps: [], download: [], upload: [] };
let prevTotals = null;
let prevPollTime = null;
let trafficPollingInterval = null;

function startTrafficPolling() {
  if (trafficPollingInterval) return;
  // Take initial reading immediately so first delta is ready after one interval
  pollTraffic().catch(() => {});
  trafficPollingInterval = setInterval(() => pollTraffic().catch(e => console.error('Traffic polling error:', e.message)), POLL_INTERVAL_SEC * 1000);
}

let gatewayMac = null;

async function pollTraffic() {
  const { baseUrl, controllerId, token, cookies, siteId } = sessionData;
  if (!token || !siteId) return;
  const headers = { 'Csrf-Token': token, Cookie: cookies };
  const base = `${baseUrl}/${controllerId}/api/v2/sites/${siteId}`;

  // Find gateway MAC on first poll
  if (!gatewayMac) {
    try {
      const devResp = await axios.get(`${base}/devices?currentPage=1&currentPageSize=50`, { httpsAgent, headers, timeout: 10000 });
      const devList = unwrap(devResp, 'Device list') || [];
      const devArr = Array.isArray(devList) ? devList : (devList.data || []);
      const gw = devArr.find(d => d.type === 'gateway');
      if (gw) {
        gatewayMac = gw.mac;
        console.log('[Traffic] Found gateway:', gw.name, gw.mac);
      }
    } catch (e) {
      console.error('[Traffic] Cannot find gateway:', e.message);
    }
  }

  if (!gatewayMac) return;

  // Fetch gateway details — has txRate, rxRate (bytes/sec), download, upload (cumulative bytes)
  const gwResp = await axios.get(`${base}/gateways/${gatewayMac}`, { httpsAgent, headers, timeout: 10000 });
  const gw = unwrap(gwResp, 'Gateway detail');
  if (!gw) return;

  // txRate/rxRate are real-time throughput in bytes/sec from the gateway
  // download/upload are cumulative totals — use as fallback via delta
  const txRate = gw.txRate || 0;  // upload rate (gateway tx = client upload to internet)
  const rxRate = gw.rxRate || 0;  // download rate (gateway rx = client download from internet)
  const download = gw.download || 0;
  const upload = gw.upload || 0;

  // Debug: remove or set to false to silence
  if (process.env.DEBUG_TRAFFIC) console.log('[Traffic] rx:', rxRate, 'tx:', txRate, 'dl:', download, 'ul:', upload);

  const now = Date.now();

  // Prefer txRate/rxRate if non-zero; otherwise compute delta from cumulative totals
  let rateDown, rateUp;
  if (rxRate > 0 || txRate > 0) {
    rateDown = rxRate;
    rateUp = txRate;
  } else if (prevTotals !== null) {
    const elapsedSec = prevPollTime ? (now - prevPollTime) / 1000 : POLL_INTERVAL_SEC;
    const deltaDown = Math.max(0, download - prevTotals.download);
    const deltaUp = Math.max(0, upload - prevTotals.upload);
    rateDown = elapsedSec > 0 ? deltaDown / elapsedSec : 0;
    rateUp = elapsedSec > 0 ? deltaUp / elapsedSec : 0;
  } else {
    prevTotals = { download, upload };
    prevPollTime = now;
    return;
  }

  prevTotals = { download, upload };
  prevPollTime = now;

  trafficHistory.timestamps.push(now);
  trafficHistory.download.push(rateDown);
  trafficHistory.upload.push(rateUp);

  if (trafficHistory.timestamps.length > TRAFFIC_HISTORY_SIZE) {
    trafficHistory.timestamps.shift();
    trafficHistory.download.shift();
    trafficHistory.upload.shift();
  }
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    authenticated: !!sessionData.token,
  });
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { host, username, password } = req.body;
  if (!host || !username || !password) {
    return res.status(400).json({ error: 'host, username, and password are required' });
  }
  const baseUrl = `https://${host}`;

  try {
    const info = unwrap(
      await axios.get(`${baseUrl}/api/info`, { httpsAgent, timeout: 10000 }),
      'Controller info'
    );
    const controllerId = info?.omadacId;
    if (!controllerId) return res.status(502).json({ error: 'Controller returned no omadacId' });

    // NOTE: a call to /api/v2/hotspot/login used to run here. Its response was
    // never read - it is the captive-portal endpoint, not the controller login -
    // so it only submitted the credentials a second time for no reason.
    const loginResp = await axios.post(
      `${baseUrl}/${controllerId}/api/v2/login`,
      { username, password },
      { httpsAgent, headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    const token = unwrap(loginResp, 'Login')?.token;
    if (!token) throw new Error('Login succeeded but the controller returned no CSRF token');
    const rawCookies = loginResp.headers['set-cookie'];
    const cookieStr = rawCookies ? rawCookies.map(c => c.split(';')[0]).join('; ') : '';

    sessionData = { token, cookies: cookieStr, baseUrl, controllerId };

    const sitesResp = await axios.get(
      `${baseUrl}/${controllerId}/api/v2/sites?currentPage=1&currentPageSize=10`,
      { httpsAgent, headers: { 'Csrf-Token': token, Cookie: cookieStr }, timeout: 10000 }
    );

    const sites = unwrap(sitesResp, 'Site list')?.data || [];
    if (sites.length > 0) {
      sessionData.siteId = sites[0].id;
    }

    // Start traffic polling after login
    startTrafficPolling();

    res.json({ success: true, sites, controllerId });
  } catch (err) {
    console.error('Login error:', err.message);
    // errorCode set => the controller rejected us (bad credentials, etc).
    // Absent => we never got a valid reply (unreachable, TLS, redirect).
    const status = err.errorCode !== undefined ? 401 : 502;
    res.status(status).json({ error: err.message || 'Login failed', errorCode: err.errorCode });
  }
});

// SET SITE
app.post('/api/set-site', (req, res) => {
  const { siteId } = req.body;
  if (!siteId) return res.status(400).json({ error: 'siteId is required' });
  sessionData.siteId = siteId;
  res.json({ success: true });
});

// PROXY helper
async function omadaGet(apiPath) {
  const { baseUrl, controllerId, token, cookies, siteId } = sessionData;
  if (!token || !siteId) throw new Error('Not logged in or no site selected');
  const url = `${baseUrl}/${controllerId}/api/v2/sites/${siteId}${apiPath}`;
  const resp = await axios.get(url, {
    httpsAgent,
    headers: { 'Csrf-Token': token, Cookie: cookies },
    timeout: 15000,
    // An expired session answers 302 -> /login. Following it produced a
    // confusing "Protocol http: not supported" instead of a real message.
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 300,
  });
  return unwrap(resp, `GET ${apiPath}`);
}

// DASHBOARD DATA
app.get('/api/dashboard', async (req, res) => {
  try {
    const [clients, devices, events] = await Promise.allSettled([
      omadaGet('/insight/clients?currentPage=1&currentPageSize=200'),
      omadaGet('/devices?currentPage=1&currentPageSize=200'),
      omadaGet('/events?currentPage=1&currentPageSize=20'),
    ]);

    const clientData = clients.status === 'fulfilled' ? clients.value : null;
    const deviceList = devices.status === 'fulfilled' ? (devices.value || []) : [];
    const eventData = events.status === 'fulfilled' ? events.value : null;

    // devices result is an array directly
    const devArr = Array.isArray(deviceList) ? deviceList : (deviceList.data || []);

    res.json({
      clients: clientData,
      aps: { data: devArr.filter(d => d.type === 'ap') },
      switches: { data: devArr.filter(d => d.type === 'switch') },
      gateways: { data: devArr.filter(d => d.type === 'gateway') },
      devices: devArr,
      events: eventData,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TRAFFIC HISTORY
app.get('/api/traffic-history', (req, res) => {
  res.json(trafficHistory);
});

// ALERTS
app.get('/api/alerts', async (req, res) => {
  try {
    const data = await omadaGet('/events?currentPage=1&currentPageSize=20');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Omada Dashboard running on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  if (trafficPollingInterval) clearInterval(trafficPollingInterval);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

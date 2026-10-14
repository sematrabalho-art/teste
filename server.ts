import express from 'express';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parsing
app.use(express.json());

// Cached session for oziel.galvao
let cachedSession: { token: string; expires: number; username: string } | null = null;

async function requestSiglonToken(user = 'oziel.galvao', pass = '20767849'): Promise<{ token: string; expires: number; username: string }> {
  const postData = new URLSearchParams({
    username: user,
    password: pass,
    client: 'referer',
    referer: 'https://geo.londrina.pr.gov.br',
    expiration: '20160',
    f: 'json',
  }).toString();

  const options: https.RequestOptions = {
    hostname: 'geo.londrina.pr.gov.br',
    port: 443,
    path: '/portal/sharing/rest/generateToken',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
      Origin: 'https://geo.londrina.pr.gov.br',
      Referer: 'https://geo.londrina.pr.gov.br/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    rejectUnauthorized: false,
  };

  return new Promise((resolve, reject) => {
    const tokenReq = https.request(options, (tokenRes) => {
      let body = '';
      tokenRes.on('data', (chunk) => (body += chunk));
      tokenRes.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.token) {
            resolve({ token: json.token, expires: json.expires, username: user });
          } else {
            reject(new Error(json.error?.message || json.error?.details || 'Falha ao autenticar no SIGLON.'));
          }
        } catch (e) {
          reject(new Error('Erro ao processar resposta do servidor SIGLON.'));
        }
      });
    });

    tokenReq.on('error', (err) => reject(err));
    tokenReq.write(postData);
    tokenReq.end();
  });
}

// Auto-session endpoint: returns active token for oziel.galvao
app.get('/api/arcgis-auth/session', async (_req, res) => {
  try {
    const now = Date.now();
    if (cachedSession && cachedSession.expires > now + 600000) {
      return res.json({ success: true, ...cachedSession });
    }
    const session = await requestSiglonToken('oziel.galvao', '20767849');
    cachedSession = session;
    return res.json({ success: true, ...session });
  } catch (err: any) {
    return res.status(502).json({ error: err.message || 'Falha ao gerar sessão SIGLON' });
  }
});

// SIGLON Portal Authentication endpoint
app.post('/api/arcgis-auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }

  try {
    const session = await requestSiglonToken(username, password);
    cachedSession = session;
    return res.json({ success: true, ...session });
  } catch (err: any) {
    return res.status(401).json({ error: err.message });
  }
});

// Fetch private WebAppViewer configuration with token
app.get('/api/arcgis-auth/webapp-config', (req, res) => {
  const token = (req.query.token as string) || '';
  const appId = (req.query.appId as string) || '6e505befb3be4535a772c698502233f9';

  const queryParams = new URLSearchParams({ f: 'json' });
  if (token) {
    queryParams.set('token', token);
  }

  const options: https.RequestOptions = {
    hostname: 'geo.londrina.pr.gov.br',
    port: 443,
    path: `/portal/sharing/rest/content/items/${appId}/data?${queryParams.toString()}`,
    method: 'GET',
    headers: {
      referer: 'https://geo.londrina.pr.gov.br',
    },
    rejectUnauthorized: false,
  };

  const reqGet = https.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', (chunk) => (body += chunk));
    proxyRes.on('end', () => {
      try {
        const json = JSON.parse(body);
        return res.json(json);
      } catch (e) {
        return res.status(proxyRes.statusCode || 500).send(body);
      }
    });
  });

  reqGet.on('error', (err) => {
    return res.status(502).json({ error: err.message });
  });

  reqGet.end();
});

// Proxy endpoint for ArcGIS SIGLON to bypass CORS and SSL nuances
app.use('/api/arcgis', (req, res) => {
  const targetUrl = new URL(req.url, 'https://geo.londrina.pr.gov.br');
  
  const options: https.RequestOptions = {
    hostname: 'geo.londrina.pr.gov.br',
    port: 443,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: 'geo.londrina.pr.gov.br',
      referer: 'https://geo.londrina.pr.gov.br/',
      origin: 'https://geo.londrina.pr.gov.br',
    },
    rejectUnauthorized: false,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, {
      ...proxyRes.headers,
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('ArcGIS Proxy Error:', err);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to contact SIGLON ArcGIS server', details: err.message });
    }
  });

  req.pipe(proxyReq);
});

// Serve static frontend assets in production
const distPath = path.resolve(__dirname, 'dist');
app.use(express.static(distPath));

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, Plugin } from 'vite';

// Cached session for oziel.galvao
let cachedSession: { token: string; expires: number; username: string } | null = null;

async function requestSiglonToken(user = 'oziel.galvao', pass = '20767849'): Promise<{ token: string; expires: number; username: string }> {
  const https = await import('https');
  const postData = new URLSearchParams({
    username: user,
    password: pass,
    client: 'referer',
    referer: 'https://geo.londrina.pr.gov.br',
    expiration: '20160',
    f: 'json',
  }).toString();

  const options = {
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
      let resBody = '';
      tokenRes.on('data', (c) => (resBody += c));
      tokenRes.on('end', () => {
        try {
          const j = JSON.parse(resBody);
          if (j.token) {
            resolve({ token: j.token, expires: j.expires, username: user });
          } else {
            reject(new Error(j.error?.message || j.error?.details || 'Falha ao autenticar no SIGLON'));
          }
        } catch (e) {
          reject(new Error('Erro ao interpretar resposta do SIGLON'));
        }
      });
    });

    tokenReq.on('error', (err) => reject(err));
    tokenReq.write(postData);
    tokenReq.end();
  });
}

function arcgisAuthPlugin(): Plugin {
  return {
    name: 'arcgis-auth-plugin',
    configureServer(server) {
      // Auto-session endpoint: provides authenticated token for oziel.galvao
      server.middlewares.use('/api/arcgis-auth/session', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        try {
          // If cached token exists and has > 10 min left, reuse
          const now = Date.now();
          if (cachedSession && cachedSession.expires > now + 600000) {
            res.statusCode = 200;
            return res.end(JSON.stringify({ success: true, ...cachedSession }));
          }

          const session = await requestSiglonToken('oziel.galvao', '20767849');
          cachedSession = session;
          res.statusCode = 200;
          return res.end(JSON.stringify({ success: true, ...session }));
        } catch (err: any) {
          res.statusCode = 502;
          return res.end(JSON.stringify({ error: err.message || 'Falha ao gerar sessão SIGLON' }));
        }
      });

      server.middlewares.use('/api/arcgis-auth/login', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end('Method Not Allowed');
        }
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const { username, password } = JSON.parse(body);
            const session = await requestSiglonToken(username, password);
            cachedSession = session;
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify({ success: true, ...session }));
          } catch (e: any) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message || 'Credenciais inválidas' }));
          }
        });
      });

      server.middlewares.use('/api/arcgis-auth/webapp-config', async (req, res) => {
        const url = new URL(req.url || '', 'http://localhost');
        const token = url.searchParams.get('token') || cachedSession?.token || '';
        const appId = url.searchParams.get('appId') || '6e505befb3be4535a772c698502233f9';
        const https = await import('https');

        const queryParams = new URLSearchParams({ f: 'json' });
        if (token) queryParams.set('token', token);

        const options = {
          hostname: 'geo.londrina.pr.gov.br',
          port: 443,
          path: `/portal/sharing/rest/content/items/${appId}/data?${queryParams.toString()}`,
          method: 'GET',
          headers: { referer: 'https://geo.londrina.pr.gov.br' },
          rejectUnauthorized: false,
        };

        const r = https.request(options, (pRes) => {
          let b = '';
          pRes.on('data', (c) => (b += c));
          pRes.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = pRes.statusCode || 200;
            res.end(b);
          });
        });

        r.on('error', (err) => {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        });

        r.end();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), arcgisAuthPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: {
        '/api/arcgis': {
          target: 'https://geo.londrina.pr.gov.br',
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/api\/arcgis/, ''),
        },
      },
    },
  };
});

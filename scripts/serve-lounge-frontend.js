/**
 * @file serve-lounge-frontend.js
 * @description Local Static Asset Web Server & Raw-Byte API Reverse Proxy for Private Lounge Dev/E2E.
 *
 * Serves compiled Angular 22 assets from `apps/lounge-frontend/dist/lounge-frontend/browser`
 * on `http://127.0.0.1:4300` and forwards `/api/*` and `/health` requests transparently to the
 * isolated Private Lounge BFF server (`http://127.0.0.1:8083`), preserving raw byte streams
 * (required for Stripe webhook HMAC signature verification).
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = 4300;
const BFF_PORT = 8083;
const DIST_DIR = path.resolve(
  __dirname,
  '../apps/lounge-frontend/dist/lounge-frontend/browser',
);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Safely resolves and serves a static file from `baseDir` without path traversal.
 * Returns `'served'`, `'forbidden'`, or `'missing'`.
 */
function tryServeStaticFile(baseDir, rawRelativeUrl, res) {
  const safeRelativePath = path.normalize(rawRelativeUrl).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.resolve(baseDir, '.' + path.sep + safeRelativePath);

  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return 'forbidden';
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return 'missing';
    }
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': content.length,
    });
    res.end(content);
    return 'served';
  } catch {
    return 'missing';
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = req.url || '/';

  // 1. Reverse Proxy: forward /api/* and /health requests verbatim to Lounge BFF (port 8083)
  if (reqUrl.startsWith('/api/') || reqUrl === '/health') {
    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: BFF_PORT,
        path: reqUrl,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${BFF_PORT}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      const safeMsg = String(err?.message || '').replace(/[\r\n]/g, '');
      console.error('[Lounge Proxy Error] %s', safeMsg);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Gateway: Lounge BFF unreachable' }));
    });
    if (req.method === 'GET' || req.method === 'HEAD') {
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
    return;
  }

  const rawPath = reqUrl.split('?')[0];

  // 2. Static File Resolution inside DIST_DIR
  const distResult = tryServeStaticFile(DIST_DIR, rawPath, res);
  if (distResult === 'served' || distResult === 'forbidden') {
    return;
  }

  // 3. SPA Fallback: return index.html for client-side navigation
  const indexPath = path.join(DIST_DIR, 'index.html');
  try {
    const content = fs.readFileSync(indexPath);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': content.length,
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[Lounge SPA Server] Running on http://127.0.0.1:${PORT} (Proxying /api/ -> 127.0.0.1:${BFF_PORT})`,
  );
});

/**
 * @file serve-frontend.js
 * @description Parameterized Local Static Asset Web Server & Raw-Byte API Reverse Proxy for E2E / Dev.
 *
 * Serves a compiled Angular SPA bundle (`FRONTEND_DIST_DIR`) on `http://127.0.0.1:<FRONTEND_PORT>`,
 * forwards `/api/*` and `/health` requests transparently (preserving raw streams for Stripe webhook HMAC
 * verification) to the Express BFF server on `127.0.0.1:<BFF_PORT>`, and optionally serves deterministic
 * `/e2e-assets/*` fixtures from `E2E_ASSETS_DIR`.
 *
 * Environment Variables:
 *   FRONTEND_PORT     - Listening port (default: 4200)
 *   BFF_PORT          - Target Express BFF port (default: 8081)
 *   FRONTEND_DIST_DIR - Path to built SPA directory, absolute or relative to `scripts/`
 *                       (default: `../apps/dashboard-frontend/dist/dashboard-frontend/browser`)
 *   E2E_ASSETS_DIR    - Optional static fixture directory (default: `../apps/dashboard-e2e/test-assets`)
 *   SERVER_LABEL      - Log label prefix (default: `Dashboard`)
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function resolvePositivePort(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function resolveConfiguredDir(rawValue, defaultRelative) {
  const candidate = String(rawValue ?? '').trim();
  if (!candidate) {
    return path.resolve(__dirname, defaultRelative);
  }
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(__dirname, candidate);
}

const PORT = resolvePositivePort(process.env.FRONTEND_PORT, 4200);
const BFF_PORT = resolvePositivePort(process.env.BFF_PORT, 8081);
const DIST_DIR = resolveConfiguredDir(
  process.env.FRONTEND_DIST_DIR,
  '../apps/dashboard-frontend/dist/dashboard-frontend/browser',
);
const E2E_ASSETS_DIR = resolveConfiguredDir(
  process.env.E2E_ASSETS_DIR,
  '../apps/dashboard-e2e/test-assets',
);
const SERVER_LABEL = (String(process.env.SERVER_LABEL ?? 'Dashboard').trim() || 'Dashboard').replace(
  /[\r\n]/g,
  '',
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
 * Safely reads and serves a static file directly via `fs.readFileSync` inside `try/catch`
 * (avoiding pre-check TOCTOU races) with strict path-traversal containment.
 * Returns `'served'`, `'forbidden'`, or `'missing'`.
 */
function tryServeStaticFile(baseDir, rawRelativeUrl, res) {
  const trimmedRel = String(rawRelativeUrl ?? '').replace(/^[/\\]+/, '');
  const safeRelativePath = path.normalize(trimmedRel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.resolve(baseDir, '.' + path.sep + safeRelativePath);

  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return 'forbidden';
  }

  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': content.length,
    });
    res.end(content);
    return 'served';
  } catch {
    return 'missing';
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = req.url ?? '/';

  // 1. Reverse Proxy: forward /api/* and /health requests verbatim to Express BFF
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
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      const safeMsg = String(err && err.message ? err.message : err).replace(/[\r\n]/g, '');
      console.error('[%s Proxy Error] %s', SERVER_LABEL, safeMsg);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Bad Gateway: ${SERVER_LABEL} BFF unreachable` }));
      } else {
        res.destroy();
      }
    });
    if (req.method === 'GET' || req.method === 'HEAD') {
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
    return;
  }

  const rawPath = reqUrl.split('?')[0];

  // 2. Serve optional E2E fixture assets when present without external network calls
  if (rawPath.startsWith('/e2e-assets/')) {
    const e2eResult = tryServeStaticFile(E2E_ASSETS_DIR, rawPath.slice('/e2e-assets/'.length), res);
    if (e2eResult === 'missing') {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // 3. Static File Resolution within DIST_DIR
  const distResult = tryServeStaticFile(DIST_DIR, rawPath, res);
  if (distResult === 'served' || distResult === 'forbidden') {
    return;
  }

  // 4. SPA Fallback: return index.html for Angular client-side navigation
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
    `[${SERVER_LABEL} SPA Server] Running on http://127.0.0.1:${PORT} (Proxying /api/ -> 127.0.0.1:${BFF_PORT})`,
  );
});

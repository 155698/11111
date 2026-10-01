import http from 'http';
import path from 'path';
import fs from 'fs';
import { startChatServer } from './chat.js';
import { createDatabase } from './db.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function serveStatic(req, res, publicDir) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);
  // prevent path traversal
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath).pipe(res);
    } else if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      const idx = path.join(filePath, 'index.html');
      if (fs.existsSync(idx)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(idx).pipe(res);
      } else { res.writeHead(404); res.end('Not found'); }
    } else {
      // SPA fallback (base './' means hashed assets resolve fine, but keep for safety)
      res.writeHead(404); res.end('Not found');
    }
  } catch (e) { res.writeHead(500); res.end('Server error'); }
}

export async function startServer(options = {}) {
  const dataDir = options.dataDir || process.env.APP_DATA_DIR || path.join(__dirname, '..', 'data');
  // port from options/env/--port arg
  const argPort = Number(process.argv[process.argv.indexOf('--port') + 1]);
  const port = options.port || argPort || Number(process.env.PORT) || 3001;
  // static client build lives in ../public (relative to dist/index.cjs -> server/public)
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');

  const db = await createDatabase(dataDir);

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    // update manifest: version of the latest installer + URL to download
    if (req.url && req.url.startsWith('/version.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: process.env.APP_VERSION || options.version || '1.1.4',
        downloadUrl: process.env.DOWNLOAD_URL || options.downloadUrl || '',
        installer: options.installerName || 'MultiVoice Setup 1.1.4.exe',
      }));
      return;
    }
    // unless it's a websocket upgrade, serve static SPA
    if (req.url && (req.url.startsWith('/ws') || req.headers.upgrade === 'websocket')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'multitool-voice-server', ws: `/ws` }));
      return;
    }
    serveStatic(req, res, publicDir);
  });

  startChatServer(server, db);

  await new Promise((resolve) => server.listen(port, resolve));

  return {
    port,
    db,
    server,
    close() {
      server.close();
      try { db._db.close(); } catch {}
    },
  };
}

// CLI mode: node dist/index.cjs [port]
const isCli = process.argv.length >= 2 && process.argv[1] &&
  (process.argv[1].endsWith('index.cjs') || process.argv[1].endsWith('index.js') || /dist[\\/](index\.cjs|index\.js)$/.test(process.argv[1]));
if (typeof require !== 'undefined' && require.main === module && isCli) {
  startServer().then(({ port }) => {
    console.log(`[server] http://0.0.0.0:${port}  ws://0.0.0.0:${port}/ws`);
  }).catch((e) => {
    console.error('Failed to start server:', e);
    process.exit(1);
  });
}
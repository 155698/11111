// Собирает серверное ядро (WebSocket + sql.js) в единый CJS-бандл для Electron.
// Запуск: node scripts/build-server.mjs  (из app/)
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, '..');
const serverSrc = path.join(appRoot, '..', 'server', 'src', 'index.js');
const outDir = path.join(appRoot, 'server-dist');
const outFile = path.join(outDir, 'server.cjs');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [serverSrc],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: outFile,
  sourcemap: false,
  external: ['electron'],
  banner: { js: "/* multitool-voice embedded server */" },
});

// copy sql.js wasm next to the bundle
const wasmSrc = path.join(serverSrc, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmDst = path.join(outDir, 'sql-wasm.wasm');
if (fs.existsSync(wasmSrc)) {
  fs.copyFileSync(wasmSrc, wasmDst);
  console.log('[build] server wasm copied -> server-dist/sql-wasm.wasm');
} else {
  console.warn('[build] WARN: sql-wasm.wasm not found');
}

console.log('[build] server bundle -> server-dist/server.cjs');
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/index.cjs',
  sourcemap: false,
});

// copy sql.js wasm next to the bundle
const wasmSrc = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmDst = path.join(__dirname, 'dist', 'sql-wasm.wasm');
if (fs.existsSync(wasmSrc)) {
  fs.copyFileSync(wasmSrc, wasmDst);
  console.log('[build] copied sql-wasm.wasm -> dist/');
} else {
  console.warn('[build] WARN: sql-wasm.wasm not found, voice/db may fail');
}

console.log('[build] server -> dist/index.cjs');
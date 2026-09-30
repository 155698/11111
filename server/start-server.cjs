// Auto-start guard for the MultiVoice web server.
// If port 3000 is already in use (server running), do nothing.
// Otherwise spawn the server and exit.
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.MVT_PORT || 3000);
const SERVER_SCRIPT = path.join(__dirname, 'dist', 'index.cjs');

const probe = () => new Promise((resolve) => {
  const sock = net.connect(PORT, '127.0.0.1');
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('error', () => resolve(false));
});

probe().then((inUse) => {
  if (inUse) {
    console.log(`[autostart] port ${PORT} already in use — server already running, exiting.`);
    return;
  }
  console.log(`[autostart] starting server on port ${PORT}...`);
  const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(PORT)], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => process.exit(0), 500);
});
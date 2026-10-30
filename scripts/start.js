#!/usr/bin/env node
// Cross-platform launcher for `npm start` / `npm run dev`.
// Electron must not inherit ELECTRON_RUN_AS_NODE (some terminals and editors
// set it), and `env -u` only exists on macOS/Linux, so clear it here instead.
// If the app crashes (killed by a fault signal, not quit by the user), it is
// started again, up to MAX_RESTARTS times within RESTART_WINDOW_MS.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
// Signals that mean someone chose to stop the app; don't restart after these.
const STOP_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT']);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let restarts = [];
let child = null;

function launch() {
  child = spawn(electron, ['.', ...process.argv.slice(2)], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'inherit',
    windowsHide: false
  });

  child.on('exit', (code, signal) => {
    const crashed = signal && !STOP_SIGNALS.has(signal);
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (crashed && restarts.length < MAX_RESTARTS) {
      restarts.push(now);
      console.error(`[start] OpenCluely crashed (${signal}); restarting (${restarts.length}/${MAX_RESTARTS})`);
      setTimeout(launch, 1000);
      return;
    }
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

// Pass Ctrl+C / termination through to the app instead of orphaning it
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (child) child.kill(sig); });
}

launch();

/**
 * Run the observer server AND the web dev UI together — the app is a pure
 * client, so development needs both processes:
 *   npm run dev:all
 * (equivalent: `npm run server` in one terminal, `npm run dev` in another.)
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const children = [
  spawn('npm', ['run', 'server'], { cwd: webDir, stdio: 'inherit', env: process.env }),
  spawn('npm', ['run', 'dev'], { cwd: webDir, stdio: 'inherit', env: process.env })
];

const shutdown = () => {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
};

for (const child of children) {
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[dev:all] a process exited with code ${String(code)} — shutting the other down`);
      shutdown();
      process.exit(code ?? 1);
    }
  });
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

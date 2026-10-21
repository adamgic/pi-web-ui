#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node start.mjs [Pi options]\nStarts Pi with this extension and opens the browser.\nExamples: --continue, --web-ui-port 4317, --web-ui-no-open\nRun from the project directory you want Pi to work in. Set PI_BIN if pi is not on PATH.');
} else {
  const extension = fileURLToPath(new URL('./src/index.ts', import.meta.url));
  const child = spawn(process.env.PI_BIN || 'pi', ['--extension', extension, '--web-ui', ...args], { stdio: 'inherit' });
  child.once('error', error => {
    console.error(`Could not start Pi: ${error.message}\nInstall @earendil-works/pi-coding-agent, or set PI_BIN to your Pi executable.`);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';

// Browser startup gets its own budget: shared CI runners can take longer than
// the UI assertions, especially on their first Chrome launch.
export async function launchChrome({ executable, profile, logPath, timeoutMs = 60_000, args = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
] }) {
  const log = await open(logPath, 'w');
  let child;
  try {
    child = spawn(executable, args, { stdio: ['ignore', log.fd, log.fd] });
  } catch (error) {
    await log.close();
    throw error;
  }
  let failure;
  const ended = new Promise(resolve => {
    child.once('error', error => { failure = `Could not launch Chrome: ${error.message}`; resolve(); });
    child.once('exit', (code, signal) => { failure = `Chrome exited during startup (code ${code}, signal ${signal})`; resolve(); });
  });
  await log.close();
  const stop = async () => {
    if (failure) return;
    child.kill('SIGTERM');
    let timer;
    await Promise.race([ended, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    if (!failure) { child.kill('SIGKILL'); await ended; }
  };
  const deadline = performance.now() + timeoutMs;
  let lastError;
  try {
    while (performance.now() < deadline) {
      if (failure) throw new Error(failure);
      try {
        const port = (await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0];
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid DevTools port');
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(1000, Math.ceil(deadline - performance.now())))),
        });
        if (!response.ok) throw new Error(`DevTools returned HTTP ${response.status}`);
        const pages = await response.json();
        const page = pages.find(page => page.type === 'page' && page.webSocketDebuggerUrl);
        if (!page) throw new Error('DevTools has no page target yet');
        if (failure) throw new Error(failure);
        return { page, stop };
      } catch (error) { lastError = error; }
      await Promise.race([pause(100), ended]);
    }
    throw new Error(failure || `Timed out after ${timeoutMs}ms waiting for Chrome startup: ${lastError?.message || 'DevTools unavailable'}`);
  } catch (error) {
    await stop();
    const output = await readFile(logPath, 'utf8');
    throw new Error(`${error.message}\nChrome executable: ${executable}\nChrome log: ${logPath}\n${output.slice(-16_384) || '(no Chrome output)'}`, { cause: error });
  }
}

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { launchChrome } from './chrome.mjs';

async function setup(t, mode) {
  const profile = await mkdtemp(join(tmpdir(), 'pi-chrome-test-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const script = join(profile, 'fake-chrome.mjs');
  await writeFile(script, `
    import { createServer } from 'node:http';
    import { writeFile } from 'node:fs/promises';
    const [profile, mode] = process.argv.slice(2);
    console.error('Fake Chrome started');
    if (mode === 'exit') { console.error('Browser launch failed for test'); process.exit(17); }
    await writeFile(profile + '/pid', String(process.pid));
    if (mode === 'hang') {
      setInterval(() => {}, 1000);
    } else {
      const started = performance.now();
      const server = createServer((request, response) => {
        if (performance.now() - started < 10_100) {
          response.writeHead(503).end('Not ready yet');
        } else {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify([{type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/fake-page'}]));
        }
      });
      server.listen(0, '127.0.0.1', async () => {
        await writeFile(profile + '/DevToolsActivePort', String(server.address().port));
      });
    }
  `);
  return { executable: process.execPath, profile, logPath: join(profile, 'chrome.log'), args: [script, profile, mode] };
}

test('Chrome startup tolerates more than ten seconds and waits for DevTools readiness', { timeout: 20_000 }, async t => {
  const options = await setup(t, 'delayed');
  const chrome = await launchChrome(options);
  t.after(chrome.stop);
  assert.equal(chrome.page.webSocketDebuggerUrl, 'ws://127.0.0.1/fake-page');
  assert.match(await readFile(options.logPath, 'utf8'), /Fake Chrome started/);
});

test('Chrome exit fails promptly and includes exit status and stderr', { timeout: 5000 }, async t => {
  const options = await setup(t, 'exit');
  await assert.rejects(launchChrome(options), error => {
    assert.match(error.message, /Chrome exited during startup \(code 17/);
    assert.match(error.message, /Browser launch failed for test/);
    assert.ok(error.message.includes(options.logPath));
    return true;
  });
});

test('Missing Chrome executable reports the spawn error', { timeout: 5000 }, async t => {
  const options = await setup(t, 'exit');
  await assert.rejects(launchChrome({ ...options, executable: join(options.profile, 'missing-chrome') }), /Could not launch Chrome:.*ENOENT/);
});

test('Chrome startup timeout includes diagnostics and terminates the child', { timeout: 5000 }, async t => {
  const options = await setup(t, 'hang');
  await assert.rejects(launchChrome({ ...options, timeoutMs: 1000 }), error => {
    assert.match(error.message, /Timed out after 1000ms waiting for Chrome startup/);
    assert.match(error.message, /Fake Chrome started/);
    return true;
  });
  const pid = Number(await readFile(join(options.profile, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

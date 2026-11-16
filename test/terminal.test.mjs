import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await pause(20); }
  assert.fail('Timed out waiting for terminal output or cleanup.');
}

test('authenticated terminal runs a persistent PTY shell, resizes, interrupts, and cleans up', { skip: process.platform === 'win32' }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pi-terminal-')));
  await mkdir(join(cwd, 'child folder'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const server = await startServer({ subscribe: () => () => {}, current: () => ({ session: { cwd } }) }, {
    terminalOptions: { shell: '/bin/sh', args: ['-i'], env: { ...process.env, ENV: '', PS1: 'test$ ' } },
  });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const request = (path, method, body) => fetch(server.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await fetch(`${server.origin}/api/terminal`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${server.origin}/api/terminal`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/terminal', 'POST', { cwd: 'relative' })).status, 400);
  assert.equal((await request('/api/terminal', 'POST', { rows: 0 })).status, 400);
  assert.equal((await request('/api/terminal', 'POST', { cwd: join(cwd, 'missing') })).status, 404);
  for (const asset of ['/terminal.html', '/terminal.js', '/terminal.css', '/branch.js', '/vendor/xterm/xterm.js', '/vendor/xterm/xterm.css', '/vendor/xterm/addon-fit.js']) assert.equal((await fetch(server.origin + asset)).status, 200);

  const opened = await request('/api/terminal', 'POST', {});
  assert.equal(opened.status, 201);
  const terminal = await opened.json();
  assert.equal(terminal.cwd, cwd);
  const path = `/api/terminal/${terminal.id}`;
  assert.equal((await fetch(server.origin + path + '/events')).status, 401);
  assert.equal((await fetch(server.origin + path, { method: 'POST' })).status, 401);
  const stream = await request(path + '/events', 'GET');
  assert.equal(stream.status, 200);
  assert.equal((await request(path + '/events', 'GET')).status, 409);
  const reader = stream.body.getReader(); let output = '', exit;
  const collecting = (async () => {
    const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const chunk = await reader.read(); if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith('data: ')) continue;
        const event = JSON.parse(frame.slice(6));
        if (event.type === 'data') output += event.data;
        if (event.type === 'exit') exit = event.exitCode;
      }
    }
  })();
  const input = async data => assert.equal((await request(path, 'POST', { action: 'input', data })).status, 200);
  await input('test -t 0 && printf "\\nPTY_%s\\n" OK\r');
  await until(() => output.includes('PTY_OK'));
  await input('cd "child folder"; saved_value=persisted\r');
  await input('printf "\\nSTATE=%s\\n" "$saved_value"; pwd\r');
  await until(() => output.includes('STATE=persisted') && output.includes(join(cwd, 'child folder')));
  assert.equal((await request(path, 'POST', { action: 'resize', cols: 101, rows: 37 })).status, 200);
  await input('stty size\r');
  await until(() => output.includes('37 101'));
  assert.equal((await request(path, 'POST', { action: 'resize', cols: -1, rows: 37 })).status, 400);
  assert.equal((await request(path, 'POST', { action: 'input', data: 'x'.repeat(65537) })).status, 400);
  await input('printf "\\nWAIT_%s\\n" READY; sleep 30\r');
  await until(() => output.includes('WAIT_READY'));
  await input('\u0003');
  await input('printf "\\nAFTER_%s\\n" INTERRUPT\r');
  await until(() => output.includes('AFTER_INTERRUPT'));
  await input('exit 7\r');
  await collecting;
  assert.equal(exit, 7);
  assert.equal((await request(path, 'POST', { action: 'input', data: 'pwd\r' })).status, 404);

  // Closing the output stream closes its shell; stopping the server does too.
  for (const shutdown of ['disconnect', 'server']) {
    const next = await (await request('/api/terminal', 'POST', {})).json();
    const nextPath = `/api/terminal/${next.id}`;
    const response = await request(nextPath + '/events', 'GET');
    const nextReader = response.body.getReader();
    await request(nextPath, 'POST', { action: 'input', data: 'printf "\\nPID=%s\\n" "$$"\r' });
    let text = '';
    while (!/PID=(\d+)/.test(text)) text += new TextDecoder().decode((await nextReader.read()).value);
    const pid = Number(text.match(/PID=(\d+)/)[1]);
    if (shutdown === 'disconnect') await nextReader.cancel();
    else { await server.close(); await nextReader.cancel(); }
    await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
    if (shutdown === 'disconnect') assert.equal((await request(nextPath + '/events', 'GET')).status, 404);
  }
});

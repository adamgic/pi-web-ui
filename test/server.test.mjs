import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { startServer } from '../src/server.mjs';
import { createBridge } from '../src/bridge.mjs';
import { fixture } from './fixture.mjs';

test('authenticated HTTP, SSE, replay protection, input limits and shutdown', async t => {
  const { pi, ctx, state } = fixture();
  const bridge = createBridge(pi); bridge.update({ type: 'session_start' }, ctx);
  const web = await startServer(bridge);
  t.after(() => web.close());
  const headers = { Authorization: `Bearer ${web.token}`, 'Content-Type': 'application/json' };
  const post = command => fetch(`${web.origin}/api/command`, { method: 'POST', headers, body: JSON.stringify(command) });
  const command = (action, fields = {}) => ({ action, sessionId: state.id, requestId: randomUUID(), ...fields });
  assert.equal((await fetch(`${web.origin}/api/events`)).status, 401);
  assert.equal((await fetch(`${web.origin}/api/events`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    get(web.origin, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${web.origin}/src/bridge.mjs`)).status, 404);
  for (const asset of ['/', '/app.js', '/view.js', '/style.css']) {
    const response = await fetch(`${web.origin}${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  const stream = await fetch(`${web.origin}/api/events`, { headers });
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /test-session/);
  const message = command('submit', { text: 'Hello', whenBusy: 'steer' });
  assert.deepEqual((await Promise.all([post(message), post(message)])).map(response => response.status), [200, 200]);
  assert.equal(state.calls.length, 1);
  assert.equal((await post({ ...message, text: 'Changed' })).status, 409);
  assert.equal((await post(command('submit', { text: 'x'.repeat(270000), whenBusy: 'steer' }))).status, 413);
  assert.equal((await post(command('abort', { sessionId: 'old' }))).status, 409);
  bridge.update({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Live answer' }] } }, ctx);
  assert.match(new TextDecoder().decode((await reader.read()).value), /Live answer/);
  // A normal snapshot can exceed Node's writable high-water mark. That is not a failed connection.
  bridge.update({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200000) + 'large-snapshot-end' }] } }, ctx);
  let large = '';
  while (!large.includes('\n\n')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    large += new TextDecoder().decode(chunk.value);
  }
  assert.match(large, /large-snapshot-end/);
  await reader.cancel();
  await web.close(); await web.close();
  await assert.rejects(fetch(web.origin));
});

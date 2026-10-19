import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../src/extension.js';
import { fixture } from './fixture.mjs';

test('extension has no factory side effects; commands start/stop, sessions clean up', async t => {
  const f = fixture(); f.flags.set('web-ui-no-open', true);
  extension(f.pi);
  t.after(() => f.emit('session_shutdown'));
  assert.equal(f.state.notices.length, 0);
  await f.emit('session_start');
  assert.equal(f.state.notices.length, 0);
  const command = text => f.commands.get('web').handler(text, f.ctx);
  await Promise.all([command('url'), command('url')]);
  const urls = f.state.notices.map(item => item.text.match(/http:\/\/\S+/)?.[0]).filter(Boolean);
  assert.equal(urls.length, 2); assert.equal(urls[0], urls[1]);
  assert.equal((await fetch(urls[0])).status, 200);
  await command('stop'); await assert.rejects(fetch(urls[0]));
  await command('url');
  const next = f.state.notices.at(-1).text.match(/http:\/\/\S+/)[0];
  await f.emit('session_shutdown'); await assert.rejects(fetch(next));
  f.flags.set('web-ui', true);
  await f.emit('session_start');
  assert.match(f.state.notices.at(-1).text, /Pi Web UI: http/);
});

test('invalid port is reported without opening a server', async () => {
  const f = fixture(); f.flags.set('web-ui-port', 'bad'); f.flags.set('web-ui', true);
  extension(f.pi); await f.emit('session_start');
  assert.equal(f.state.notices.at(-1).level, 'error');
  assert.match(f.state.notices.at(-1).text, /integer/);
  await f.emit('session_shutdown');
});

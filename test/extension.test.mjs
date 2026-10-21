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

test('browser session changes hand the same server to a fresh extension runtime', async t => {
  let active;
  let cancelled = false;
  const entries = [{ id: 'saved', path: '/example/saved.jsonl', name: 'Saved', modified: new Date(), messageCount: 2 }];
  const create = id => {
    const f = fixture(); f.state.id = id;
    f.flags.set('web-ui', true); f.flags.set('web-ui-no-open', true);
    extension(f.pi, { listSessions: async () => entries });
    const dispatch = async text => {
      const [name, ...args] = text.slice(1).split(' ');
      await f.commands.get(name).handler(args.join(' '), f.ctx);
    };
    f.pi.sendUserMessage = (text, options) => {
      assert.equal(options.expandPromptTemplates, true);
      void dispatch(text);
    };
    f.ctx.sendUserMessage = dispatch;
    const replace = async (nextId, options) => {
      if (cancelled) return { cancelled: true };
      await f.emit('session_shutdown', { reason: 'new' });
      active = create(nextId);
      await active.emit('session_start', { reason: 'new', previousSessionFile: '/example/session.jsonl' });
      await options.withSession(active.ctx);
      return { cancelled: false };
    };
    f.ctx.newSession = options => replace('fresh', options);
    f.ctx.switchSession = (path, options) => replace(path === '/example/saved.jsonl' ? 'saved' : 'bad', options);
    return f;
  };
  active = create('initial');
  t.after(() => active.emit('session_shutdown', { reason: 'quit' }));
  await active.emit('session_start');
  const url = new URL(active.state.notices[0].text.slice('Pi Web UI: '.length));
  const headers = { Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get('token')}`, 'Content-Type': 'application/json' };
  const state = () => fetch(`${url.origin}/api/state`, { headers }).then(response => response.json());
  const post = (action, fields = {}) => fetch(`${url.origin}/api/command`, { method: 'POST', headers, body: JSON.stringify({
    action, sessionId: active.state.id, requestId: crypto.randomUUID(), ...fields,
  }) });
  assert.equal((await fetch(`${url.origin}/api/sessions`, { headers }).then(response => response.json())).sessions[0].name, 'Saved');
  assert.equal((await post('switch-session', { path: '/arbitrary/path' })).status, 400);
  active.state.idle = false;
  assert.equal((await post('new-session')).status, 409);
  active.state.idle = true;
  cancelled = true;
  assert.equal((await post('new-session')).status, 409);
  assert.equal((await state()).session.id, 'initial');
  cancelled = false;
  assert.equal((await post('new-session')).status, 200);
  assert.equal((await state()).session.id, 'fresh');
  assert.equal(active.state.notices.length, 0, 'handoff must not launch a second browser/server');
  assert.equal((await post('new-session', { sessionId: 'initial' })).status, 409);
  assert.equal((await post('switch-session', { path: '/example/saved.jsonl' })).status, 200);
  assert.equal((await state()).session.id, 'saved');
  await active.emit('session_shutdown', { reason: 'quit' });
  await assert.rejects(fetch(url.origin));
});

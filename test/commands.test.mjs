import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/bridge.mjs';
import { builtinCommands, commandCatalog, parseSlash } from '../public/command-catalog.js';
import { fixture } from './fixture.mjs';

function setup(options) {
  const f = fixture();
  const bridge = createBridge(f.pi, options); bridge.update({ type: 'session_start' }, f.ctx);
  const run = (action, fields = {}) => bridge.execute({ action, sessionId: f.state.id, ...fields });
  return { ...f, bridge, run };
}

test('catalog covers Pi built-ins, discovers prompts and skills, and hides the internal dispatcher', () => {
  const piCommands = ['settings', 'model', 'tree', 'thinking', 'scoped-models', 'export', 'import', 'share', 'bug', 'copy', 'name', 'session', 'changelog', 'hotkeys', 'fork', 'clone', 'trust', 'login', 'logout', 'new', 'compact', 'resume', 'reload', 'quit'];
  for (const name of piCommands) assert.ok(builtinCommands.some(command => command.name === name), name);
  const commands = commandCatalog([{ name: 'review', source: 'prompt' }, { name: 'skill:debug', source: 'skill' }, { name: 'mcp', source: 'extension' }, { name: 'web-session', source: 'extension' }, { name: 'model', source: 'prompt' }]);
  assert.equal(commands.filter(command => command.name === 'model').length, 1);
  assert.equal(commands.some(command => command.name === 'web-session'), false);
  assert.equal(commands.find(command => command.name === 'skill:debug').mode, 'prompt');
  assert.equal(commands.find(command => command.name === 'mcp').mode, 'terminal');
  assert.deepEqual(parseSlash(' /name  New name '), { name: 'name', args: 'New name' });
  assert.equal(parseSlash('ordinary message'), undefined);
});

test('rename, explicit thinking and tools validate inputs and publish updated state', async () => {
  const { run, bridge, state } = setup();
  await run('name', { name: 'Useful name' }); assert.equal(bridge.current().session.name, 'Useful name');
  await assert.rejects(run('name', { name: ' ' }), { status: 400 });
  await run('thinking', { level: 'high' }); assert.equal(state.thinking, 'high');
  await assert.rejects(run('thinking', { level: 'unknown' }), { status: 400 });
  await run('tools', { tools: ['read'] }); assert.deepEqual(bridge.current().activeTools, ['read']);
  await assert.rejects(run('tools', { tools: ['unknown'] }), { status: 400 });
  state.idle = false; await assert.rejects(run('tools', { tools: [] }), { status: 409 });
  await assert.rejects(run('name', { name: 'Stale', sessionId: 'previous-session' }), { status: 409 });
});

test('only discovered prompts and skills can be submitted; built-ins and unknown commands never reach the model', async () => {
  const { pi, run, state } = setup();
  pi.getCommands = () => [{ name: 'review', source: 'prompt' }, { name: 'skill:debug', source: 'skill' }];
  pi.sendUserMessage = (text, options) => state.calls.push({ text, options });
  for (const text of ['/login', '/settings', '/unknown', '/web-session secret']) await assert.rejects(run('slash', { text, whenBusy: 'steer' }), { status: 400 });
  assert.equal(state.calls.length, 0);
  await run('slash', { text: '/review some arguments', whenBusy: 'followUp' });
  assert.deepEqual(state.calls[0], { text: '/review some arguments', options: { deliverAs: 'followUp', expandPromptTemplates: true } });
  await run('slash', { text: '/skill:debug', whenBusy: 'steer' });
  pi.getCommands = () => [];
  await assert.rejects(run('slash', { text: '/review', whenBusy: 'steer' }), { status: 400 });
});

test('terminal handoff never runs commands or overwrites an unfinished terminal draft', async () => {
  const { run, state } = setup();
  for (const text of ['/unknown', '/tools', '/login\n/quit', '/login\x1b[31m']) await assert.rejects(run('terminal-command', { text }), { status: 400 });
  await run('terminal-command', { text: '/login test' }); assert.equal(state.editor, '/login test');
  assert.equal(state.calls.length, 0);
  await assert.rejects(run('terminal-command', { text: '/logout' }), { status: 409 });
  assert.equal(state.editor, '/login test');
});

test('tree, fork and clone validate entries and preserve their distinct semantics', async () => {
  const calls = [];
  const { run, state } = setup({ changeSession: async command => { calls.push(command); return { accepted: true }; } });
  state.entries = [{ id: 'u1', type: 'message', message: { role: 'user', content: 'Question' } }, { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] } }];
  assert.equal((await run('command-data', { kind: 'tree' })).entries[1].parentId, 'u1');
  await assert.rejects(run('fork', { entryId: 'a1' }), { status: 400 });
  await assert.rejects(run('tree', { entryId: 'missing' }), { status: 400 });
  await run('fork', { entryId: 'u1' }); await run('clone'); await run('tree', { entryId: 'u1', summarize: true });
  assert.deepEqual(calls.map(({ action, entryId, summarize }) => ({ action, entryId, summarize })), [
    { action: 'fork', entryId: 'u1', summarize: false }, { action: 'clone', entryId: 'a1', summarize: false }, { action: 'tree', entryId: 'u1', summarize: true },
  ]);
  state.pending = true; await assert.rejects(run('clone'), { status: 409 });
});

test('command views expose session exports but never arbitrary settings or authentication values', async () => {
  const { pi, run, state } = setup({ readChangelog: async () => '# Changes' });
  pi.getSettings = () => ({ defaultModel: 'faux', providers: { secret: 'private' }, apiKey: 'secret', compaction: { enabled: false } });
  const settings = await run('command-data', { kind: 'settings' });
  assert.deepEqual(settings.settings, [{ name: 'defaultModel', value: 'faux' }, { name: 'compaction.enabled', value: false }]);
  state.entries = [{ type: 'message', id: 'user', message: { role: 'user', content: 'Test' } }];
  const exported = await run('command-data', { kind: 'export' });
  assert.equal(exported.header.id, state.id); assert.deepEqual(exported.entries, state.entries);
  assert.equal((await run('command-data', { kind: 'changelog' })).text, '# Changes');
  await assert.rejects(run('command-data', { kind: 'credentials' }), { status: 400 });
});

test('quit requires explicit confirmation and idle state', async () => {
  const { run, state } = setup();
  await assert.rejects(run('quit'), { status: 400 });
  state.idle = false; await assert.rejects(run('quit', { confirm: true }), { status: 409 });
  state.idle = true; await run('quit', { confirm: true });
  assert.deepEqual(state.calls, []);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(state.calls, [['shutdown']]);
});

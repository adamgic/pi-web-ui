import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/bridge.mjs';
import { transcriptOf, usageOf } from '../public/view.js';
import { fixture } from './fixture.mjs';

test('history and streamed messages join exactly once across Pi persistence', () => {
  const { pi, ctx, state } = fixture();
  const bridge = createBridge(pi);
  bridge.update({ type: 'session_start' }, ctx);
  const user = { role: 'user', content: 'Hello', timestamp: 1 };
  state.entries.push({ type: 'message', id: 'u1', message: user });
  const message = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], timestamp: 2,
    usage: { input: 10, output: 2, cost: { total: 0.01 } }, stopReason: 'stop' };
  bridge.update({ type: 'message_update', message }, ctx);
  assert.equal(transcriptOf(bridge.current()).at(-1).streaming, true);
  bridge.update({ type: 'message_end', message }, ctx);
  assert.equal(transcriptOf(bridge.current()).length, 2);
  state.entries.push({ type: 'message', id: 'a1', message: structuredClone(message) });
  assert.equal(transcriptOf(bridge.current()).length, 2);
  assert.equal(usageOf(bridge.current()).cost, 0.01);
  state.entries.push({ type: 'compaction', id: 'c1', summary: 'Summary' });
  assert.equal(transcriptOf(bridge.current()).at(-1).type, 'compaction');
  bridge.update({ type: 'session_start' }, ctx);
  assert.equal(bridge.current().completed.length, 0);
});

test('hidden custom and system messages stay hidden; custom persistence does not duplicate', () => {
  const { pi, ctx, state } = fixture();
  const bridge = createBridge(pi); bridge.update({ type: 'session_start' }, ctx);
  const message = { role: 'custom', customType: 'notice', content: 'Private context', display: false };
  bridge.update({ type: 'message_end', message }, ctx);
  assert.equal(transcriptOf(bridge.current()).length, 0);
  state.entries.push({ type: 'custom_message', id: 'custom', ...message });
  state.entries.push({ type: 'message', id: 'system', message: { role: 'system', content: 'Instructions' } });
  assert.equal(bridge.current().completed.length, 0);
  assert.equal(transcriptOf(bridge.current()).length, 0);
});

test('tool streaming, errors, and authoritative final output', () => {
  const { pi, ctx, state } = fixture();
  const bridge = createBridge(pi);
  bridge.update({ type: 'session_start' }, ctx);
  state.entries.push({ type: 'message', id: 'a', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'pwd' } }] } });
  bridge.update({ type: 'tool_execution_update', toolCallId: 't', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'partial' }] } }, ctx);
  assert.equal(transcriptOf(bridge.current()).at(-1).output, 'partial');
  state.entries.push({ type: 'message', id: 'r', message: { role: 'toolResult', toolCallId: 't', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'Failed' }] } });
  const tools = transcriptOf(bridge.current()).filter(item => item.type === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, 'error');
  assert.equal(tools[0].output, 'Failed');
});

test('public controls validate stale sessions, slash commands and compaction state', async () => {
  const { pi, ctx, state } = fixture();
  const bridge = createBridge(pi);
  bridge.update({ type: 'session_start' }, ctx);
  const run = (action, fields = {}) => bridge.execute({ action, sessionId: state.id, ...fields });
  await run('submit', { text: 'Hello', whenBusy: 'steer' });
  await run('submit', { text: 'Later', whenBusy: 'followUp' });
  assert.deepEqual(state.calls.slice(0, 2), [['submit', 'Hello', 'steer'], ['submit', 'Later', 'followUp']]);
  await assert.rejects(run('submit', { text: '/login', whenBusy: 'steer' }), { status: 400 });
  await assert.rejects(run('submit', { text: '', whenBusy: 'steer' }), { status: 400 });
  await assert.rejects(run('submit', { text: 'x', whenBusy: 'invalid' }), { status: 400 });
  await assert.rejects(run('abort', { sessionId: 'stale' }), { status: 409 });
  await assert.rejects(run('model', { provider: 'bad', modelId: 'bad' }), { status: 400 });
  await run('model', { provider: 'test', modelId: 'faux' });
  await run('thinking'); assert.equal(state.thinking, 'minimal');
  state.idle = false;
  await assert.rejects(run('compact'), { status: 409 });
  await run('abort');
  state.idle = true;
  await run('compact', { instructions: 'Keep decisions' });
  assert.equal(bridge.current().compacting, true);
  await assert.rejects(run('compact'), { status: 409 });
  state.compaction.onError(new Error('Cannot compact'));
  assert.equal(bridge.current().compacting, false);
  assert.equal(bridge.current().notices[0].message, 'Cannot compact');
  bridge.close();
  await assert.rejects(run('abort'), { status: 503 });
});


test('session metadata uses readable names and only abbreviates the actual home directory', () => {
  const { pi, ctx, state } = fixture();
  pi.getSessionName = () => undefined;
  const bridge = createBridge(pi);
  ctx.cwd = join(homedir(), 'workspace', 'harness');
  state.entries.push({ type: 'message', id: 'first', message: { role: 'user', content: 'Explain this project' } });
  bridge.update({ type: 'session_start' }, ctx);
  assert.equal(bridge.current().session.displayCwd, '~/workspace/harness');
  assert.equal(bridge.current().session.name, 'Explain this project');
  assert.equal(bridge.current().session.created, '2026-10-21T10:00:00Z');
  ctx.cwd = homedir();
  assert.equal(bridge.current().session.displayCwd, '~');
  ctx.cwd = homedir() + '-other/project';
  assert.equal(bridge.current().session.displayCwd, ctx.cwd);
  pi.getSessionName = () => 'Named session';
  assert.equal(bridge.current().session.name, 'Named session');
});

// Real Chromium checks using its built-in DevTools protocol; no browser-test dependency.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import { createBridge } from '../src/bridge.mjs';
import { fixture } from './fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}output`;
const profile = `${root}temp/pi-extension-chrome-${Date.now()}`;
await mkdir(out, { recursive: true });
await mkdir(profile, { recursive: true });
const f = fixture();
const saved = new Map();
const bridge = createBridge(f.pi, {
  listSessions: async () => [...saved].map(([id, entries]) => ({
    id, path: `/example/${id}.jsonl`, name: id, messageCount: entries.length, modified: new Date(),
  })),
  changeSession: async command => {
    saved.set(f.state.id, structuredClone(f.state.entries));
    f.state.id = command.action === 'new-session' ? 'new-browser-session' : command.path.split('/').at(-1).replace('.jsonl', '');
    f.state.entries = structuredClone(saved.get(f.state.id) || []);
    bridge.update({ type: 'session_start' }, f.ctx);
    return { accepted: true };
  },
});
bridge.update({ type: 'session_start' }, f.ctx);
f.pi.sendUserMessage = (text, options) => {
  f.state.calls.push(['submit', text, options.deliverAs]);
  f.state.entries.push({ type: 'message', id: String(f.state.entries.length), message: { role: 'user', content: text } });
};
const server = await startServer(bridge);
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
let socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  for (let i = 0; i < 100; i++) { try { const value = await fn(); if (value) return value; } catch { } await pause(100); }
  throw new Error(`Timed out: ${message}`);
}
const results = [];
try {
  const port = await until(async () => (await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0], 'Chrome startup');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const requests = new Map();
  const exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const entry = requests.get(message.id); if (!entry) return; clearTimeout(entry.timer); requests.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const viewport = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const arrow = key => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowUp' ? 38 : 40 });
  const input = () => evaluate("document.getElementById('prompt').value");
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await viewport(1440, 1000);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await cdp('Page.navigate', { url: server.url });
  await until(() => evaluate("document.getElementById('connection')?.textContent === 'Connected'"), 'UI connection');
  assert.equal(await evaluate('getComputedStyle(document.documentElement).colorScheme'), 'light');
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(248, 250, 249)');
  await cdp('Page.captureScreenshot', { format: 'png' }).then(result => writeFile(`${out}/desktop-empty.png`, Buffer.from(result.data, 'base64')));
  for (const [width, height] of [[1440, 1000], [1024, 768], [768, 650], [1024, 500], [600, 700]]) {
    await viewport(width, height); await pause(120);
    const dimensions = await evaluate('({width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight})');
    assert.ok(dimensions.scrollWidth <= width, JSON.stringify(dimensions));
    assert.ok(dimensions.scrollHeight <= height, JSON.stringify({ ...dimensions, boxes: await evaluate("[...document.querySelectorAll('.app,.workspace,.sidebar,main,main>*')].map(n=>({tag:n.tagName,cls:n.className,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,height:n.clientHeight,scroll:n.scrollHeight}))") }));
    results.push({ test: 'viewport without page overflow', ...dimensions });
  }
  assert.equal(await evaluate("document.getElementById('cwd').textContent"), '/example/project');
  const readyFont = await evaluate("getComputedStyle(document.getElementById('status')).fontSize");
  await viewport(1024, 500);
  assert.ok(await evaluate("document.querySelector('.sidebar').scrollHeight > document.querySelector('.sidebar').clientHeight"));
  assert.ok(await evaluate("document.getElementById('status').getBoundingClientRect().bottom <= document.getElementById('prompt').getBoundingClientRect().top"));
  assert.ok(await evaluate("document.querySelector('.sidebar').contains(document.getElementById('usage'))"));
  assert.equal(await evaluate("document.getElementById('session-details-panel').open"), false);
  assert.ok(await evaluate("document.getElementById('session-model').checkVisibility()"));
  await evaluate("document.querySelector('#session-details-panel summary').click()");
  assert.equal(await evaluate("document.getElementById('session-details-panel').open"), true);
  await evaluate("document.getElementById('session-id').focus()");
  assert.equal(await evaluate("getComputedStyle(document.getElementById('session-id-tooltip')).display"), 'block');
  assert.equal(await evaluate("document.getElementById('session-id-tooltip').textContent"), f.state.id);
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Browser.grantPermissions', { origin: new URL(server.url).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await evaluate("document.getElementById('session-id').click()");
  await until(() => evaluate("document.getElementById('copy-status').textContent === 'Session ID copied'"), 'copy session ID');
  assert.equal(await evaluate('navigator.clipboard.readText()'), f.state.id);
  const detailValues = await evaluate("[...document.querySelectorAll('#session-details .detail-copy')].map(b => ({label:b.getAttribute('aria-label'), value:b.nextElementSibling.textContent}))");
  for (let index = 0; index < detailValues.length; index++) {
    await evaluate(`document.querySelectorAll('#session-details .detail-copy')[${index}].click()`);
    await until(async () => (await evaluate('navigator.clipboard.readText()')) === detailValues[index].value, detailValues[index].label);
  }
  await evaluate("document.querySelector('#session-details-panel summary').click()");
  assert.equal(await evaluate("document.getElementById('session-details-panel').open"), false);
  assert.ok(await evaluate("document.getElementById('session-model').checkVisibility()"));
  await viewport(390, 500); await pause(150);
  const tiny = await evaluate('({width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight})');
  assert.ok(tiny.scrollHeight > tiny.height); assert.ok(tiny.scrollWidth <= tiny.width); results.push({ test: 'tiny viewport vertical fallback', ...tiny });
  await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }).then(result => writeFile(`${out}/mobile.png`, Buffer.from(result.data, 'base64')));
  await viewport(1440, 1000);
  await evaluate("document.getElementById('prompt').value = '<img src=x onerror=alert(1)> test'; document.getElementById('send').click()");
  await until(() => f.state.calls.some(c => c[0] === 'submit'), 'submit forwarding');
  await until(() => evaluate("document.getElementById('transcript').textContent.includes('<img src=x')"), 'safe prompt rendering');
  assert.equal(await evaluate("document.querySelectorAll('#transcript img').length"), 0);
  await evaluate("document.getElementById('prompt').focus()");
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  assert.equal(await evaluate("document.getElementById('prompt').value"), '<img src=x onerror=alert(1)> test');
  await arrow('ArrowDown'); assert.equal(await input(), '');
  await evaluate("document.getElementById('prompt').value = 'Draft line one\\nDraft line two'; document.getElementById('prompt').setSelectionRange(5, 5)");
  await arrow('ArrowUp'); assert.equal(await input(), '<img src=x onerror=alert(1)> test');
  await arrow('ArrowDown'); assert.equal(await input(), 'Draft line one\nDraft line two');
  assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), 5);
  await evaluate("document.getElementById('prompt').setSelectionRange(20, 20)");
  await arrow('ArrowUp'); assert.equal(await input(), 'Draft line one\nDraft line two');
  const firstLineCaret = await evaluate("document.getElementById('prompt').selectionStart");
  assert.ok(firstLineCaret < 'Draft line one\n'.length, 'Up moves the caret to the first line before recalling history');
  await arrow('ArrowUp'); assert.equal(await input(), '<img src=x onerror=alert(1)> test');
  await evaluate("document.getElementById('prompt').value = 'Recalled first line\\nRecalled last line'; document.getElementById('prompt').setSelectionRange(4, 4)");
  for (let i = 0; i < 3; i++) {
    await arrow('ArrowUp');
    assert.equal(await input(), 'Recalled first line\nRecalled last line');
    assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), 4, 'Up at the oldest entry must not move the caret');
    assert.equal(await evaluate("document.getElementById('prompt').selectionEnd"), 4);
  }
  await arrow('ArrowDown'); assert.equal(await input(), 'Recalled first line\nRecalled last line');
  assert.ok(await evaluate("document.getElementById('prompt').selectionStart") >= 'Recalled first line\n'.length);
  await arrow('ArrowDown'); assert.equal(await input(), 'Draft line one\nDraft line two');
  assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), firstLineCaret);
  await evaluate("document.getElementById('prompt').setSelectionRange(0, 5)");
  await arrow('ArrowUp'); assert.equal(await input(), 'Draft line one\nDraft line two');
  await evaluate("document.getElementById('prompt').value = ''");
  await evaluate("document.getElementById('thinking').click()");
  await until(() => evaluate("document.getElementById('thinking').textContent.includes('minimal')"), 'thinking');
  await evaluate("document.getElementById('model').click()");
  await until(() => evaluate("document.getElementById('model-dialog').open"), 'model picker');
  await evaluate("document.querySelector('#models button').click()");
  await until(() => evaluate("!document.getElementById('model-dialog').open"), 'model selection');
  await evaluate("document.getElementById('prompt').value = 'next'; document.getElementById('follow-up').click()");
  await until(() => f.state.calls.some(c => c[0] === 'submit' && c[2] === 'followUp'), 'follow-up');
  await until(() => input().then(text => text === ''), 'cleared composer');
  await evaluate("document.getElementById('prompt').focus(); document.getElementById('prompt').value = 'Unsent draft'");
  await arrow('ArrowUp'); assert.equal(await input(), 'next');
  await arrow('ArrowUp'); assert.equal(await input(), '<img src=x onerror=alert(1)> test');
  await arrow('ArrowUp'); assert.equal(await input(), '<img src=x onerror=alert(1)> test');
  await arrow('ArrowDown'); assert.equal(await input(), 'next');
  await evaluate("document.getElementById('prompt').value = 'Edited first line\\nEdited middle line\\nEdited last line'; document.getElementById('prompt').setSelectionRange(5, 5)");
  await arrow('ArrowUp');
  assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), 5, 'Up preserves the column');
  await arrow('ArrowDown'); assert.equal(await input(), 'Edited first line\nEdited middle line\nEdited last line');
  assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), 5, 'Down preserves the column on the first line');
  await arrow('ArrowDown'); assert.equal(await input(), 'Edited first line\nEdited middle line\nEdited last line');
  const middleCaret = await evaluate("document.getElementById('prompt').selectionStart");
  assert.ok(middleCaret >= 'Edited first line\n'.length && middleCaret < 'Edited first line\nEdited middle line\n'.length);
  await arrow('ArrowDown'); assert.equal(await input(), 'Edited first line\nEdited middle line\nEdited last line');
  assert.ok(await evaluate("document.getElementById('prompt').selectionStart") >= 'Edited first line\nEdited middle line\n'.length);
  await arrow('ArrowDown'); assert.equal(await input(), 'Unsent draft');
  await arrow('ArrowDown'); assert.equal(await input(), 'Unsent draft');
  await evaluate("document.getElementById('prompt').value += ' continued'");
  await arrow('ArrowUp'); assert.equal(await input(), 'next');
  await arrow('ArrowDown'); assert.equal(await input(), 'Unsent draft continued');
  await evaluate("document.getElementById('prompt').value = ''");
  await arrow('ArrowUp'); await arrow('ArrowUp'); await arrow('ArrowDown'); await arrow('ArrowDown');
  assert.equal(await input(), '');
  await evaluate("document.getElementById('prompt').value = '123456'; document.getElementById('prompt').setSelectionRange(5, 5)");
  await arrow('ArrowUp'); assert.equal(await input(), 'next');
  assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), 4, 'Clamp to a shorter destination line');
  await arrow('ArrowUp');
  assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), 4);
  await evaluate("document.getElementById('prompt').value = 'Long first line\\nxy'; document.getElementById('prompt').setSelectionRange(4, 4)");
  await arrow('ArrowDown'); assert.equal(await input(), 'Long first line\nxy');
  await arrow('ArrowDown'); assert.equal(await input(), 'next');
  await evaluate("document.getElementById('prompt').setSelectionRange(4, 4)");
  await arrow('ArrowUp'); assert.equal(await input(), 'Long first line\nxy');
  assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), 'Long first line\nxy'.length, 'Up clamps within the last line of older history');
  await arrow('ArrowDown'); assert.equal(await input(), 'next');
  assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), 2, 'Down carries the previous last-line column');
  await arrow('ArrowDown'); assert.equal(await input(), '123456');
  assert.equal(await evaluate("document.getElementById('prompt').selectionStart"), 5, 'Draft restores its saved caret');
  await evaluate("document.getElementById('prompt').value = ''");
  f.state.idle = false;
  bridge.update({
    type: 'message_update', message: {
      role: 'assistant', content: [
        { type: 'text', text: '## Inspecting the project\nThe browser shares this Pi session.' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'src/main.ts' } },
      ]
    }
  }, f.ctx);
  bridge.update({ type: 'tool_execution_update', toolCallId: 'c1', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'export function main() {}' }] } }, f.ctx);
  await until(() => evaluate("document.querySelector('.tool-card') !== null"), 'streaming tool card');
  await until(() => evaluate("document.getElementById('status').textContent === 'Thinking…'"), 'thinking indicator');
  assert.equal(await evaluate("getComputedStyle(document.getElementById('status')).animationName"), 'thinking-shimmer');
  assert.equal(await evaluate("getComputedStyle(document.getElementById('status')).fontSize"), readyFont);
  const position = await evaluate("getComputedStyle(document.getElementById('status')).backgroundPosition");
  await pause(150);
  assert.notEqual(await evaluate("getComputedStyle(document.getElementById('status')).backgroundPosition"), position);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until(() => evaluate("getComputedStyle(document.getElementById('status')).animationName === 'none'"), 'reduced motion');
  assert.equal(await evaluate("document.getElementById('status').textContent"), 'Thinking…');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await evaluate("document.getElementById('expand').click()");
  assert.equal(await evaluate("document.querySelector('.tool-card').open"), true);
  await cdp('Page.captureScreenshot', { format: 'png' }).then(result => writeFile(`${out}/desktop-active.png`, Buffer.from(result.data, 'base64')));
  for (const theme of ['dark', 'light']) {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await until(() => evaluate(`getComputedStyle(document.documentElement).colorScheme === '${theme}'`), `${theme} appearance without reload`);
    const colors = await evaluate(`({
      body: getComputedStyle(document.body).backgroundColor,
      message: getComputedStyle(document.querySelector('.message.user')).backgroundColor,
      code: getComputedStyle(document.querySelector('pre')).backgroundColor,
      composer: getComputedStyle(document.getElementById('composer')).backgroundColor
    })`);
    assert.deepEqual(colors, theme === 'light'
      ? { body: 'rgb(248, 250, 249)', message: 'rgb(237, 245, 239)', code: 'rgb(239, 243, 241)', composer: 'rgb(255, 255, 255)' }
      : { body: 'rgb(17, 23, 25)', message: 'rgb(25, 38, 35)', code: 'rgb(13, 19, 21)', composer: 'rgb(24, 32, 35)' });
    await cdp('Page.captureScreenshot', { format: 'png' }).then(result => writeFile(`${out}/desktop-${theme}.png`, Buffer.from(result.data, 'base64')));
    results.push({ test: `${theme} appearance applied live`, status: 'pass' });
  }
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => f.state.calls.some(c => c[0] === 'abort'), 'escape abort');
  f.state.idle = true;
  bridge.update({ type: 'agent_end' }, f.ctx);
  await until(() => evaluate("!document.getElementById('compact').disabled"), 'idle controls');
  assert.equal(await evaluate("document.getElementById('status').textContent"), 'Ready');
  assert.equal(await evaluate("getComputedStyle(document.getElementById('status')).animationName"), 'none');
  await evaluate("document.getElementById('compact').click(); document.getElementById('compact-instructions').value = 'Keep decisions'; document.querySelector('#compact-form button[type=submit]').click()");
  await until(() => f.state.calls.some(c => c[0] === 'compact' && c[1] === 'Keep decisions'), 'compaction');
  f.state.compaction.onComplete({});
  await cdp('Page.reload');
  await until(() => evaluate("document.getElementById('connection')?.textContent === 'Connected' && document.querySelector('.tool-card')"), 'reload reconnect');
  assert.equal(f.state.calls.filter(c => c[0] === 'submit').length, 2, 'reload must not replay prompts');
  await evaluate("document.getElementById('prompt').focus()");
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  assert.equal(await evaluate("document.getElementById('prompt').value"), 'next');
  await arrow('ArrowUp'); assert.equal(await input(), '<img src=x onerror=alert(1)> test');
  await arrow('ArrowDown'); assert.equal(await input(), 'next');
  await arrow('ArrowDown'); assert.equal(await input(), '');
  await evaluate("document.getElementById('prompt').value = 'Original session draft'; document.getElementById('sessions').click()");
  await until(() => evaluate("document.getElementById('session-dialog').open"), 'session picker');
  await evaluate("document.getElementById('new-session').click()");
  await until(() => evaluate("document.getElementById('session-id').textContent.includes('new-browser-session')"), 'new session');
  assert.equal(await input(), '');
  assert.equal(await evaluate("document.querySelectorAll('#transcript .message').length"), 0);
  await until(() => evaluate("!document.getElementById('session-dialog').open"), 'session picker closes after creating');
  await evaluate("document.getElementById('prompt').value = 'New session draft'; document.getElementById('sessions').click()");
  await until(() => evaluate("document.querySelector('#session-list button') !== null && document.getElementById('session-dialog').open"), 'saved session list');
  await evaluate("document.querySelector('#session-list button').click()");
  await until(() => evaluate("document.getElementById('session-id').textContent === 'SESSION test-session'"), 'switch back');
  assert.equal(await input(), 'Original session draft');
  assert.equal(await evaluate("document.querySelectorAll('#transcript .message.user').length"), 2);
  results.push({ test: 'New session, saved session picker, unchanged connection, restored history and per-session drafts', status: 'pass' });
  results.push({ test: 'Full directory path, sidebar usage, short-window scrolling, status position and size, ID tooltip and clipboard', status: 'pass' });
  await evaluate("document.getElementById('prompt').value = '/login'; document.getElementById('send').click()");
  await until(() => evaluate("document.getElementById('alerts').textContent.includes('terminal')"), 'terminal-only command guidance');
  assert.equal(f.state.calls.filter(c => c[0] === 'submit').length, 2);
  assert.deepEqual(exceptions, []);
  results.push({ test: 'browser controls, safe rendering, streaming, reload without replay', status: 'pass' });
  results.push({ test: 'Arrow Up recall, draft preservation, recall after reload, thinking animation, idle reset and reduced motion', status: 'pass' });
  results.push({ test: 'Bidirectional multi-prompt history, oldest/newest boundaries, multiline draft and caret restoration, recalled edits and empty draft', status: 'pass' });
  results.push({ test: 'Multiline caret movement precedes history navigation in both directions; selections keep native behavior', status: 'pass' });
  results.push({ test: 'Repeated Up on the first line of the oldest history entry preserves text and caret', status: 'pass' });
  results.push({ test: 'Down enters newer multiline history on its first line and traverses each line before restoring the draft', status: 'pass' });
  results.push({ test: 'History switches preserve character column in both directions, clamp short lines, and restore the draft caret', status: 'pass' });
  await writeFile(`${out}/browser-results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  socket?.close(); chrome.kill('SIGTERM'); await server.close();
}

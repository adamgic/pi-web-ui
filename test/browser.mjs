// Real Chromium checks using its built-in DevTools protocol; no browser-test dependency.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const mediaDiagnostics = [];
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
    if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/media/')) {
      const { status, mimeType, headers } = message.params.response;
      mediaDiagnostics.push({ event: 'response', status, mimeType, headers });
    }
    if (message.method === 'Network.loadingFailed') mediaDiagnostics.push({ event: 'loadingFailed', ...message.params });
    if (message.method === 'Log.entryAdded' && ['warning', 'error'].includes(message.params.entry.level)) mediaDiagnostics.push({ event: 'browserLog', ...message.params.entry });
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
  await cdp('Network.enable'); await cdp('Log.enable');
  await viewport(1440, 1000);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await cdp('Page.navigate', { url: server.url });
  await until(() => evaluate("document.getElementById('connection')?.textContent === 'Connected'"), 'UI connection');
  const links = await evaluate(`(async () => {
    const { prose } = await import('/prose.js');
    const node = prose('[Notes](<docs/My Notes.md>) README.md:12 https://example.com \`src/app.js\`\\n<script>bad()</script>', { token: 'test', cwd: '/example/project', checkFiles: false });
    return { links: [...node.querySelectorAll('a')].map(a => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })), scripts: node.querySelectorAll('script').length };
  })()`);
  const checked = await evaluate(`(async () => {
    const { prose } = await import('/prose.js');
    const node = prose(${JSON.stringify('`' + root + 'README.md` `missing-file.md`')}, { token: ${JSON.stringify(server.token)}, cwd: '/example/project' });
    for (let i = 0; i < 100 && node.querySelector('[data-file-candidate]'); i++) await new Promise(r => setTimeout(r, 20));
    return { count: node.querySelectorAll('a[href]').length, text: node.textContent, href: node.querySelector('a[href]')?.getAttribute('href') };
  })()`);
  assert.equal(checked.count, 1);
  assert.match(checked.href, /README.md/);
  assert.match(checked.text, /missing-file.md/);
  assert.equal(links.links.length, 4);
  assert.equal(links.scripts, 0);
  assert.ok(links.links.every(a => a.target === '_blank' && a.rel.includes('noopener')));
  assert.match(links.links[0].href, /My\+Notes.md/);
  assert.match(links.links[1].href, /README.md%3A12/);
  results.push({ test: 'Markdown links, bare paths, inline code paths, external URLs and safe DOM rendering', status: 'pass' });
  assert.equal(await evaluate('document.title'), 'Test session');
  assert.equal(await evaluate("document.querySelector('link[rel=icon]').getAttribute('href')"), '/favicon.svg');
  f.pi.getSessionName = () => undefined;
  bridge.update({ type: 'session_start' }, f.ctx);
  await until(() => evaluate("document.title === 'pi-web-ui'"), 'empty session page title');
  f.pi.getSessionName = () => 'Renamed session';
  bridge.update({ type: 'session_start' }, f.ctx);
  await until(() => evaluate("document.title === 'Renamed session'"), 'renamed page title');
  f.pi.getSessionName = () => 'Test session';
  bridge.update({ type: 'session_start' }, f.ctx);
  const table = await evaluate(`(async () => {
    const { prose } = await import('/prose.js');
    const node = prose(${JSON.stringify('| Name | Value | Note |\n| :--- | ---: | :---: |\n| *italic* | **bold** | _also italic_ |\n| \`a|b\` | escaped\\|pipe | snake_case_name |'.replaceAll('\`', '`'))}, { checkFiles: false });
    return { rows: node.querySelectorAll('tbody tr').length, headers: node.querySelectorAll('th').length, em: node.querySelectorAll('em').length, bold: node.querySelectorAll('strong').length, code: node.querySelector('code')?.textContent, cells: [...node.querySelectorAll('td')].map(n => n.textContent), aligns: [...node.querySelectorAll('th')].map(n => n.className) };
  })()`);
  assert.equal(table.rows, 2); assert.equal(table.headers, 3); assert.equal(table.em, 2); assert.equal(table.bold, 1);
  assert.equal(table.code, 'a|b'); assert.ok(table.cells.includes('escaped|pipe')); assert.ok(table.cells.includes('snake_case_name'));
  assert.deepEqual(table.aligns, ['align-left', 'align-right', 'align-center']);
  results.push({ test: 'Markdown tables, aligned formatted cells, italics, pi favicon and live session titles', status: 'pass' });
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
  await until(() => evaluate("document.querySelector('#toasts .toast-message')?.textContent === 'Session ID copied'"), 'copy session ID');
  assert.equal(await evaluate('navigator.clipboard.readText()'), f.state.id);
  await pause(600);
  assert.equal(await evaluate("document.querySelectorAll('.sidebar [role=tooltip]').length"), 1);
  const detailValues = await evaluate("[...document.querySelectorAll('#session-details .detail-copy')].map(b => ({label:b.getAttribute('aria-label'), value:b.textContent}))");
  for (let index = 0; index < detailValues.length; index++) {
    await evaluate(`document.querySelectorAll('#session-details .detail-copy')[${index}].click()`);
    await until(async () => (await evaluate('navigator.clipboard.readText()')) === detailValues[index].value, detailValues[index].label);
  }
  assert.equal(await evaluate("document.querySelectorAll('#toasts .toast').length"), detailValues.length + 1);
  const firstRemainingTop = await evaluate("document.querySelectorAll('#toasts .toast')[1].getBoundingClientRect().top");
  await until(() => evaluate("document.querySelector('#toasts .toast')?.classList.contains('leaving')"), 'oldest toast expires first');
  await pause(220);
  assert.ok(await evaluate("document.querySelector('#toasts .toast').getBoundingClientRect().top") < firstRemainingTop);
  await until(() => evaluate("document.querySelectorAll('#toasts .toast').length === 0"), 'copy notifications expire');
  results.push({ test: 'Copy toasts stack, expire oldest first after three seconds, and move remaining messages upward', status: 'pass' });
  assert.ok(await evaluate("document.getElementById('session-model').getBoundingClientRect().top < document.getElementById('session-details-panel').getBoundingClientRect().top"));
  assert.equal(await evaluate("[...document.querySelectorAll('#session-details dt')].some(n => n.textContent === 'Model')"), false);
  assert.equal(await evaluate("document.getElementById('session-id').textContent"), f.state.id);
  for (const [id, value] of [['cwd', f.ctx.cwd], ['session-name', f.pi.getSessionName()], ['session-model', f.state.model.id]]) {
    await evaluate(`document.getElementById('${id}').click()`);
    await until(async () => (await evaluate('navigator.clipboard.readText()')) === value, `copy ${id}`);
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
  assert.equal(await evaluate("document.getElementById('expand').textContent"), 'Expand tool details');
  assert.ok(await evaluate("Math.abs(document.getElementById('expand').getBoundingClientRect().top + document.getElementById('expand').offsetHeight / 2 - document.getElementById('status').getBoundingClientRect().top - document.getElementById('status').offsetHeight / 2) < 2"));
  await evaluate("document.querySelector('.copy-response').click()");
  await until(async () => (await evaluate('navigator.clipboard.readText()')) === '## Inspecting the project\nThe browser shares this Pi session.', 'copy original response Markdown');
  results.push({ test: 'Copy response preserves raw Markdown; tool toggle has no shortcut hint and aligns with status', status: 'pass' });

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
  await until(() => evaluate("document.getElementById('session-id').textContent === 'test-session'"), 'switch back');
  assert.equal(await input(), 'Original session draft');
  assert.equal(await evaluate("document.querySelectorAll('#transcript .message.user').length"), 2);
  results.push({ test: 'New session, saved session picker, unchanged connection, restored history and per-session drafts', status: 'pass' });
  results.push({ test: 'Full directory path, sidebar usage, short-window scrolling, status position and size, ID tooltip and clipboard', status: 'pass' });
  await evaluate("document.getElementById('prompt').value = '/login'; document.getElementById('send').click()");
  await until(() => evaluate("document.getElementById('alerts').textContent.includes('terminal')"), 'terminal-only command guidance');
  assert.equal(f.state.calls.filter(c => c[0] === 'submit').length, 2);
  const mathFixture = await readFile(`${root}test/fixtures/tidal-forces.md`, 'utf8');
  const expectedMath = [...mathFixture.matchAll(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g)].length;
  await cdp('Page.navigate', { url: `${server.origin}/preview.html?${new URLSearchParams({ path: `${root}test/fixtures/tidal-forces.md` })}#token=${server.token}` });
  await until(() => evaluate("document.querySelectorAll('#content math').length > 0"), 'tidal equations');
  assert.equal(await evaluate("document.querySelectorAll('#content math').length"), expectedMath);
  assert.equal(await evaluate("document.querySelectorAll('.equation-error').length"), 0);
  assert.ok(await evaluate("document.querySelectorAll('mfrac').length > 0 && document.querySelectorAll('mtable').length > 0"));
  await evaluate('document.fonts.ready');
  await evaluate("document.querySelector('.equation-display').scrollIntoView({ block: 'start' })");
  await cdp('Page.captureScreenshot', { format: 'png' }).then(result => writeFile(`${out}/tidal-equations.png`, Buffer.from(result.data, 'base64')));
  await evaluate("document.getElementById('toggle').click()");
  assert.equal(await evaluate("document.getElementById('content').textContent"), mathFixture);
  await evaluate("document.getElementById('toggle').click()");
  assert.equal(await evaluate("document.querySelectorAll('#content math').length"), expectedMath);
  const edgeMath = await evaluate(`(async () => {
    const { prose } = await import('/prose.js');
    const node = prose(${JSON.stringify('Inline $x^2$ and ` $code$ `\n\n```tex\n$x$\n```\n\n$$\n\\notACommand{x}\n$$')}, { checkFiles: false });
    return { math: node.querySelectorAll('math').length, errors: node.querySelectorAll('.equation-error').length, code: node.querySelector('pre').textContent };
  })()`);
  assert.equal(edgeMath.math, 1);
  assert.equal(edgeMath.errors, 1);
  assert.match(edgeMath.code, /\$x\$/);
  results.push({ test: 'Tidal document equations, fractions, aligned groups, source toggle, code exclusions and invalid math fallback', status: 'pass', equations: expectedMath });
  const openSource = async filename => {
    await cdp('Page.navigate', { url: `${server.origin}/preview.html?${new URLSearchParams({ path: `${root}test/fixtures/${filename}` })}#token=${server.token}` });
    await until(() => evaluate("Boolean(document.querySelector('.source-code'))"), `source preview ${filename}`);
    assert.equal(await evaluate("document.querySelector('.source-code').textContent"), await readFile(`${root}test/fixtures/${filename}`, 'utf8'));
  };
  await openSource('nesting.py');
  assert.equal(await evaluate("document.getElementById('highlight-mode').value"), 'nesting');
  assert.ok(await evaluate("new Set([...document.querySelectorAll('[data-depth]')].map(n => n.dataset.depth)).size >= 4"));
  for (const theme of ['light', 'dark']) {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    const colors = await evaluate("[...document.querySelectorAll('#color-legend span')].map(n => getComputedStyle(n).color)");
    assert.equal(new Set(colors).size, 5);
    assert.equal(colors[0], theme === 'light' ? 'rgb(23, 86, 169)' : 'rgb(128, 186, 255)');
    await cdp('Page.captureScreenshot', { format: 'png' }).then(result => writeFile(`${out}/python-nesting-${theme}.png`, Buffer.from(result.data, 'base64')));
  }
  await evaluate("document.getElementById('highlight-mode').value = 'standard'; document.getElementById('highlight-mode').dispatchEvent(new Event('change'))");
  assert.ok(await evaluate("Boolean(document.querySelector('.hljs-keyword')) && !document.querySelector('[data-depth]')"));
  assert.equal(await evaluate("document.querySelector('.source-code').textContent"), await readFile(`${root}test/fixtures/nesting.py`, 'utf8'));
  await cdp('Page.captureScreenshot', { format: 'png' }).then(result => writeFile(`${out}/python-standard-dark.png`, Buffer.from(result.data, 'base64')));
  await openSource('nesting.json');
  assert.equal(await evaluate("document.getElementById('highlight-mode').value"), 'standard');
  assert.ok(await evaluate("Boolean(document.querySelector('.hljs-attr'))"));
  await evaluate("document.getElementById('highlight-mode').value = 'nesting'; document.getElementById('highlight-mode').dispatchEvent(new Event('change'))");
  const jsonDepths = await evaluate("[...document.querySelectorAll('[data-depth]')].map(n => ({ text: n.textContent, depth: Number(n.dataset.depth) }))");
  assert.equal(jsonDepths.find(n => n.text.includes('\"project\"')).depth, 0);
  assert.equal(jsonDepths.find(n => n.text.includes('\"settings\"')).depth, 2);
  assert.equal(jsonDepths.find(n => n.text.includes('\"enabled\"')).depth, 4);
  assert.equal(jsonDepths.find(n => n.text.includes('true')).depth, 5);
  for (const theme of ['light', 'dark']) {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await cdp('Page.captureScreenshot', { format: 'png' }).then(result => writeFile(`${out}/json-nesting-${theme}.png`, Buffer.from(result.data, 'base64')));
  }
  const safeCode = await evaluate(`(async () => {
    const { highlightedCode } = await import('/highlighting.js');
    const source = '<script>alert(1)</script>';
    return ['standard', 'nesting'].map(mode => { const node = highlightedCode(source, 'xml', mode); return { text: node.textContent, scripts: node.querySelectorAll('script').length }; });
  })()`);
  assert.deepEqual(safeCode, [{ text: '<script>alert(1)</script>', scripts: 0 }, { text: '<script>alert(1)</script>', scripts: 0 }]);
  results.push({ test: 'Python/JSON depth colors, standard Highlight.js, persistent toggle, exact source, light/dark palettes and safe markup', status: 'pass' });
  const htmlListener = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "window.addEventListener('message', event => { if (event.data?.previewTest) window.htmlPreviewResult = event.data; });" });
  const htmlSource = await readFile(`${root}test/fixtures/preview.html`, 'utf8');
  await cdp('Page.navigate', { url: `${server.origin}/preview.html?${new URLSearchParams({ path: `${root}test/fixtures/preview.html` })}#token=${server.token}` });
  await until(() => evaluate("Boolean(document.querySelector('iframe.html-preview'))"), 'HTML iframe');
  await until(() => evaluate('Boolean(window.htmlPreviewResult)'), 'rendered HTML script and document');
  const frameResult = await evaluate('window.htmlPreviewResult');
  assert.equal(frameResult.heading, 'Rendered HTML preview');
  assert.equal(frameResult.color, 'rgb(20, 90, 160)');
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: htmlListener.identifier });
  assert.equal(await evaluate('document.body.dataset.previewEscaped'), undefined);
  assert.equal(await evaluate("document.getElementById('highlight-controls').hidden"), true);
  await evaluate("document.getElementById('toggle').click()");
  assert.equal(await evaluate("document.querySelector('.source-code').textContent"), htmlSource);
  assert.ok(await evaluate("document.querySelectorAll('[data-depth]').length > 2"));
  await evaluate("document.getElementById('highlight-mode').value = 'standard'; document.getElementById('highlight-mode').dispatchEvent(new Event('change'))");
  assert.ok(await evaluate("Boolean(document.querySelector('.hljs-tag'))"));
  await evaluate("document.getElementById('toggle').click()");
  assert.ok(await evaluate("Boolean(document.querySelector('iframe.html-preview'))"));
  results.push({ test: 'HTML native rendering, relative CSS, isolated scripts, source toggle and both highlighting modes', status: 'pass' });
  // Decode a fixed, validated VP8 clip. Recording a canvas for 300 ms here
  // made this test depend on headless capture/encoder scheduling on the runner.
  const png = await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#80baff'; ctx.fillRect(0, 0, 160, 90);
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  await writeFile(`${out}/native-image.png`, Buffer.from(png, 'base64'));
  await copyFile(`${root}test/fixtures/native-video.webm`, `${out}/native-video.webm`);
  for (const [name, selector] of [['native-image.png', 'img'], ['native-video.webm', 'video']]) {
    await cdp('Page.navigate', { url: `${server.origin}/preview.html?${new URLSearchParams({ path: `${out}/${name}` })}#token=${server.token}` });
    await until(() => evaluate(`location.pathname.startsWith('/media/') && Boolean(document.querySelector('${selector}'))`), `native ${selector} viewer`);
    try {
      // Request media loading explicitly rather than relying on native autoplay
      // policy, which varies across Chrome versions and headless environments.
      if (selector === 'video') await evaluate("document.querySelector('video').preload = 'auto'; document.querySelector('video').load()");
      await until(() => evaluate(selector === 'img' ? "document.querySelector('img').naturalWidth === 160" : "document.querySelector('video').readyState >= 1"), `native ${selector} decoding`);
    } catch (error) {
      const state = await evaluate(`(() => {
        const video = document.querySelector('video');
        return { html: document.body.innerHTML, readyState: video?.readyState, networkState: video?.networkState,
          currentSrc: video?.currentSrc, paused: video?.paused, duration: video?.duration,
          width: video?.videoWidth, height: video?.videoHeight, error: video?.error && { code: video.error.code, message: video.error.message } };
      })()`);
      await writeFile(`${out}/media-diagnostics.json`, JSON.stringify({ state, events: mediaDiagnostics }, null, 2));
      throw new Error(`${error.message}: ${JSON.stringify(state)}`);
    }
    assert.equal(await evaluate("Boolean(document.querySelector('#highlight-controls, #toggle, .file-preview'))"), false);
    if (selector === 'video') {
      assert.ok(await evaluate("document.querySelector('video').controls"));
      assert.deepEqual(await evaluate("({ width: document.querySelector('video').videoWidth, height: document.querySelector('video').videoHeight })"), { width: 160, height: 90 });
      assert.equal(await evaluate("document.querySelector('video').duration"), 2);
    }
  }
  results.push({ test: 'Native image and video documents decode correctly with no app preview controls', status: 'pass' });
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
} catch (error) {
  await writeFile(`${out}/browser-results.json`, JSON.stringify({ passed: results, failure: error.stack, mediaDiagnostics }, null, 2));
  throw error;
} finally {
  socket?.close(); chrome.kill('SIGTERM'); await server.close();
}

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') || sessionStorage.getItem('pi-web-token');
if (token) sessionStorage.setItem('pi-web-token', token);
history.replaceState(null, '', location.pathname + location.search);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const terminal = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, theme: { background: '#111719', foreground: '#e4ecec', cursor: '#b4e5ce' } });
const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit);
terminal.open($('terminal')); fit.fit();
let id, ending = false, exited = false, queue = Promise.resolve(), queuedBytes = 0;
const controller = new AbortController();
function finish(message) {
  ending = true; $('terminal-status').textContent = message;
  $('terminal-close').disabled = true; $('terminal-new').hidden = false;
  terminal.options.disableStdin = true;
}
async function api(path, method, body, keepalive = false) {
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), keepalive });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Terminal request failed.');
  return data;
}
function closeShell() {
  if (id) void api(`/api/terminal/${id}`, 'DELETE', undefined, true).catch(() => {});
  controller.abort(); finish('Shell closed');
}
function send(input) {
  if (!id || ending) return;
  const size = input.data?.length || 0;
  if (queuedBytes + size > 1024 * 1024) { closeShell(); $('terminal-status').textContent = 'Input queue full; shell closed.'; return; }
  queuedBytes += size;
  queue = queue.then(async () => {
    if (!ending) await api(`/api/terminal/${id}`, 'POST', input);
  }).catch(error => {
    closeShell(); $('terminal-status').textContent = error.message;
  }).finally(() => { queuedBytes -= size; });
}
terminal.onData(data => {
  // Serial requests preserve keystroke order and never automatically replay input.
  for (let start = 0; start < data.length; start += 8192) send({ action: 'input', data: data.slice(start, start + 8192) });
});
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { fit.fit(); if (!ending) send({ action: 'resize', cols: terminal.cols, rows: terminal.rows }); }, 100);
}).observe($('terminal'));
$('terminal-close').onclick = closeShell;
$('terminal-new').onclick = () => location.reload();
window.addEventListener('pagehide', closeShell);
try {
  if (!token) throw new Error('Open this terminal from BRANCH NAME in the Pi workspace.');
  const session = await api('/api/terminal', 'POST', { cwd: params.get('cwd') || undefined, cols: terminal.cols, rows: terminal.rows });
  id = session.id;
  $('terminal-cwd').textContent = session.cwd;
  terminal.writeln(`Working directory: ${session.cwd.replace(/[\x00-\x1f\x7f-\x9f]/g, '?')}`);
  terminal.writeln('');
  const response = await fetch(`/api/terminal/${id}/events`, { headers, signal: controller.signal });
  if (!response.ok) throw new Error((await response.json()).error);
  $('terminal-status').textContent = 'Connected'; $('terminal-close').disabled = false;
  terminal.focus();
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      if (!frame.startsWith('data: ')) continue;
      const event = JSON.parse(frame.slice(6));
      if (event.type === 'data') await new Promise(resolve => terminal.write(event.data, resolve));
      if (event.type === 'exit') { exited = true; finish(`Shell exited (${event.exitCode})`); }
    }
  }
  if (!ending) finish('Disconnected — open a new shell to continue.');
} catch (error) {
  if (!ending) { closeShell(); $('terminal-status').textContent = error.message; }
} finally {
  if (!exited && id) void api(`/api/terminal/${id}`, 'DELETE', undefined, true).catch(() => {});
}

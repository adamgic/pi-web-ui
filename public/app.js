import { usageOf, transcriptOf } from './view.js';

const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') || sessionStorage.getItem('pi-web-token');
if (fragment.has('token')) { sessionStorage.setItem('pi-web-token', token); history.replaceState(null, '', location.pathname); }
let view, online = false, pending = false, expanded = false, lastTranscript = '';
let localError = '', selectedConversation, submitting = false;
const drafts = new Map();
const submittedPrompts = new Map();
let historyNavigation;
let sessions = [], sessionsRequest = 0;
const opened = new Map();
const transcript = $('transcript');
const welcome = transcript.firstElementChild;
const prompt = $('prompt');
let following = true;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
async function copyValue(label, value) {
  try { await navigator.clipboard.writeText(String(value)); showToast(`${label} copied`); }
  catch { showToast('Copy unavailable. Select the value to copy manually.'); }
}
// Oldest notices stay at the top; each expires three seconds after appearing.
function showToast(message) {
  const toast = el('div', undefined, 'toast entering');
  const content = el('div', undefined, 'toast-content');
  content.append(el('div', message, 'toast-message'));
  toast.append(content);
  $('toasts').append(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.remove('entering')));
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 180);
  }, 3000);
}
// Markdown is rendered using DOM text nodes only; model/tool HTML is never executed.
function inline(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(end, match.index)));
    const part = match[0];
    if (part.startsWith('`')) parent.append(el('code', part.slice(1, -1)));
    else if (part.startsWith('**')) parent.append(el('strong', part.slice(2, -2)));
    else {
      const split = part.indexOf('](');
      const a = el('a', part.slice(1, split));
      a.href = part.slice(split + 2, -1); a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a);
    }
    end = match.index + part.length;
  }
  parent.append(document.createTextNode(text.slice(end)));
}
function prose(text) {
  const node = el('div', undefined, 'prose');
  let code, paragraph;
  for (const line of String(text || '').split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) code = undefined;
      else { code = el('pre'); node.append(code); }
      paragraph = undefined; continue;
    }
    if (code) { code.append(document.createTextNode(`${line}\n`)); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { const h = el(`h${Math.min(4, heading[1].length + 1)}`); inline(h, heading[2]); node.append(h); paragraph = undefined; }
    else if (!line) paragraph = undefined;
    else {
      if (!paragraph) { paragraph = el('p'); node.append(paragraph); }
      else paragraph.append(document.createTextNode('\n'));
      inline(paragraph, line);
    }
  }
  return node;
}
function detail(key, title, contents, className) {
  const node = el('details', undefined, className);
  node.open = opened.get(key) ?? expanded;
  const summary = el('summary');
  summary.append(title);
  node.append(summary, contents);
  node.addEventListener('toggle', () => { if (node.isConnected) opened.set(key, node.open); });
  return node;
}
function renderTranscript() {
  const items = transcriptOf(view);
  const signature = JSON.stringify([view.session.id, items]);
  if (signature === lastTranscript) return;
  lastTranscript = signature;
  const scroll = transcript.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    if (item.type === 'tool') {
      const title = el('span'); title.append(el('strong', item.name), el('span', item.status, 'tool-state'));
      const body = el('div', undefined, 'tool-body');
      if (item.args !== undefined) body.append(el('pre', JSON.stringify(item.args, null, 2)));
      if (item.output) body.append(el('pre', item.output));
      if (item.truncated) body.append(el('p', item.truncated, 'muted'));
      fragment.append(detail(item.key, title, body, `tool-card ${item.status === 'error' ? 'error' : ''}`));
    } else if (item.type === 'compaction') fragment.append(detail(item.key, el('span', 'Context summary'), prose(item.text), 'thinking-card'));
    else {
      const message = el('article', undefined, `message ${item.type}`);
      const header = el('header', item.type === 'user' ? 'You' : item.type === 'assistant' ? `Pi${item.streaming ? ' · streaming' : ''}` : 'Context');
      if (item.type === 'assistant' && item.text) {
        const copy = el('button', 'Copy Markdown', 'quiet copy-response');
        copy.setAttribute('aria-label', 'Copy response as Markdown');
        copy.onclick = () => copyValue('Response Markdown', item.text);
        header.append(copy);
      }
      message.append(header);
      if (item.thinking) message.append(detail(`${item.key}:thinking`, el('span', 'Reasoning'), prose(item.thinking), 'thinking-card'));
      if (item.text) message.append(item.type === 'user' ? el('div', item.text, 'prose') : prose(item.text));
      if (item.error) message.append(el('p', item.error, 'danger'));
      fragment.append(message);
    }
  }
  transcript.replaceChildren(items.length ? fragment : welcome);
  transcript.scrollTop = following ? transcript.scrollHeight : scroll;
}
function renderNavigation() {
  $('tasks').replaceChildren(...view.activeTools.map(name => el('div', name, 'task')));
}
function controls() {
  document.querySelectorAll('[data-control]').forEach(button => { button.disabled = !online || pending; });
  prompt.disabled = !online || Boolean(view?.switching);
  if (view) {
    $('abort').disabled = !online || !(view.busy || view.compacting);
    $('send').textContent = view.busy ? 'Steer ↑' : 'Send ↑';
    $('compact').disabled = !online || pending || view.busy || view.compacting || view.pendingMessages;
    $('model').disabled = !online || pending || view.busy || view.compacting;
    const changingDisabled = !online || pending || view.busy || view.compacting || view.pendingMessages || view.switching;
    $('sessions').disabled = changingDisabled;
    $('new-session').disabled = changingDisabled;
    document.querySelectorAll('#session-list button').forEach(button => { button.disabled = changingDisabled || button.dataset.current === 'true'; });
    if (view.switching) document.querySelectorAll('[data-control]').forEach(button => { button.disabled = true; });
  }
  const working = online && Boolean(submitting || view?.busy || view?.compacting);
  const label = !online ? 'Disconnected' : view?.switching ? 'Switching session…' : view?.compacting ? 'Compacting…' : working ? 'Thinking…' : 'Ready';
  if ($('status').textContent !== label) $('status').textContent = label;
  $('status').classList.toggle('working', working);
}
function alerts() {
  $('alerts').replaceChildren();
  for (const notice of [...(view?.notices || []).slice(-3), ...(localError ? [{ message: localError, level: 'error' }] : [])]) $('alerts').append(el('p', notice.message, notice.level));
  $('session-error').textContent = localError;
  $('session-error').hidden = !localError;
}
function render() {
  const id = view.session.id;
  if (id !== selectedConversation) {
    if (selectedConversation !== undefined) drafts.set(selectedConversation, historyNavigation?.draft.text ?? prompt.value);
    historyNavigation = undefined;
    prompt.value = drafts.get(id) || '';
    sessions = []; filterSessions();
    selectedConversation = id; following = true; opened.clear();
  }

  $('cwd').textContent = view.session.displayCwd || view.session.cwd;
  $('session-model').textContent = view.model?.modelId || 'None selected';
  $('session-model').disabled = !view.model;
  $('session-name').textContent = view.session.name;
  const messages = transcriptOf(view).filter(item => ['user', 'assistant'].includes(item.type));
  renderMetadata($('session-details'), [
    ['Session ID', view.session.id],
    ['Created', view.session.created ? new Date(view.session.created).toLocaleString() : 'Unknown'],
    ['Branch messages', messages.length],
    ['Provider', view.model?.provider || 'None selected'],
        ['Session file', view.session.file || 'In memory'],
  ], true);
  $('conversation-title').textContent = view.session.name;
  $('model').textContent = view.model?.modelId || 'Select model';
  $('model').title = view.model ? `${view.model.provider}/${view.model.modelId}` : 'Choose a model';
  $('thinking').textContent = `Thinking: ${view.thinkingLevel || 'off'}`;
  const usage = usageOf(view);
  const format = number => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(number);
  const model = view.models.find(m => m.provider === view.model?.provider && m.modelId === view.model?.modelId);
  const windowSize = view.context?.contextWindow || model?.contextWindow;
  renderMetadata($('usage'), [
    ['Input tokens', format(usage.input)], ['Output tokens', format(usage.output)],
    ['Cache read', format(usage.cacheRead)], ['Cache write', format(usage.cacheWrite)],
    ['Context used', usage.context == null ? 'Unknown' : `${format(usage.context)}${windowSize ? ` / ${format(windowSize)} (${(usage.context / windowSize * 100).toFixed(1)}%)` : ''}`],
    ['Context capacity', windowSize ? format(windowSize) : 'Unknown'], ['Cost', `$${usage.cost.toFixed(3)}`],
  ]);
  $('queue').hidden = !view.pendingMessages;
  $('queue').replaceChildren(el('p', 'Pi has queued messages. They will appear in the transcript when consumed.'));
  renderTranscript(); renderNavigation(); alerts(); controls();
}
async function command(action, payload = {}) {
  const response = await fetch('/api/command', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, action, sessionId: selectedConversation, requestId: crypto.randomUUID() }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}
async function run(action, payload) {
  if (!online || (pending && action !== 'abort')) return false;
  if (action !== 'abort') pending = true;
  if (action === 'submit') submitting = true;
  localError = ''; alerts(); controls();
  try { await command(action, payload); return true; }
  catch (error) { localError = `Unable to confirm command: ${error.message} Check the transcript before retrying.`; alerts(); return false; }
  finally { if (action !== 'abort') pending = false; if (action === 'submit') submitting = false; controls(); }
}
async function showModels() {
  if (!view) return;
  try {
    const response = await fetch('/api/state', { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('Unable to refresh models. Reconnect using /web in the terminal.');
    view = await response.json(); render();
    $('model-search').value = ''; filterModels(); $('model-dialog').showModal(); $('model-search').focus();
  } catch (error) { localError = error.message; alerts(); }
}
function renderMetadata(node, rows, copyable = false) {
  const signature = JSON.stringify(rows);
  if (node.dataset.values === signature) return;
  node.dataset.values = signature;
  node.replaceChildren(...rows.flatMap(([label, value]) => {
    const definition = el('dd');
    if (!copyable) definition.textContent = value;
    else {
      const button = el('button', value, 'quiet detail-copy');
      button.setAttribute('aria-label', `Copy ${label}`);
      button.onclick = () => copyValue(label, value);
      definition.append(button);
      if (label === 'Session ID') {
        const tooltip = el('span', value, 'detail-tooltip');
        tooltip.id = 'session-id-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        button.id = 'session-id';
        button.classList.add('mono');
        button.setAttribute('aria-describedby', tooltip.id);
        definition.className = 'detail-copy-wrap';
        definition.append(tooltip);
      }
    }
    return [el('dt', label), definition];
  }));
}
async function refreshSessions() {
  const request = ++sessionsRequest;
  const id = selectedConversation;
  try {
    const response = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json();
    if (request !== sessionsRequest || id !== selectedConversation) return;
    if (!response.ok) throw new Error(result.error || 'Unable to load sessions.');
    if (result.sessionId !== id) return;
    sessions = result.sessions;
    filterSessions();
  } catch (error) {
    if (request !== sessionsRequest || id !== selectedConversation) return;
    if ($('session-dialog').open) { localError = error.message; alerts(); }
  }
}
async function showSessions() {
  localError = ''; alerts();
  $('session-search').value = '';
  filterSessions();
  $('session-dialog').showModal();
  $('session-search').focus();
  await refreshSessions();
}
function filterSessions() {
  const query = $('session-search').value.toLowerCase();
  const list = $('session-list');
  list.replaceChildren();
  for (const session of sessions.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(query))) {
    const current = session.id === selectedConversation;
    const button = el('button', session.name, current ? 'selected active' : '');
    button.dataset.current = String(current);
    if (current) button.setAttribute('aria-current', 'true');
    button.append(el('small', `${current ? 'Current · ' : ''}${session.messageCount} messages · ${new Date(session.modified).toLocaleString()}`));
    button.onclick = async () => { if (await run('switch-session', { path: session.path })) $('session-dialog').close(); };
    list.append(button);
  }
  if (!list.children.length) list.append(el('p', 'No saved sessions match. New sessions appear after Pi saves them.', 'muted'));
  controls();
}
function filterModels() {
  $('models').replaceChildren();
  const query = $('model-search').value.toLowerCase();
  const selected = view.model;
  const models = view.models.filter(m => `${m.provider} ${m.modelId} ${m.name}`.toLowerCase().includes(query));
  if (!models.length) $('models').append(el('p', 'No available models. Run /login in the Pi terminal, then reopen this model picker.', 'muted'));
  for (const model of models) {
    const button = el('button', model.name || model.modelId, model.provider === selected?.provider && model.modelId === selected?.modelId ? 'selected' : '');
    button.append(el('small', `${model.provider} / ${model.modelId}`));
    button.onclick = async () => { if (await run('model', { provider: model.provider, modelId: model.modelId })) $('model-dialog').close(); };
    $('models').append(button);
  }
}
async function submit(mode = 'steer') {
  const text = prompt.value.trim(); if (!text || !online || pending) return;
  const before = prompt.value;
  if (mode === 'steer' && text.startsWith('/')) {
    if (text === '/model') showModels();
    else if (text === '/help') $('help-dialog').showModal();
    else if (text === '/thinking') { if (!await run('thinking')) return; }
    else if (text === '/abort') { if (!await run('abort')) return; }
    else if (/^\/compact(?:\s|$)/.test(text)) { if (!await run('compact', { instructions: text.slice(8).trim() })) return; }
    else { localError = 'Run /login and other Pi commands in the terminal. Use /help for browser commands.'; alerts(); return; }
    prompt.value = ''; historyNavigation = undefined; return;
  }
  const id = selectedConversation;
  const historyLength = transcriptOf(view).filter(item => item.type === 'user').length;
  if (await run('submit', { text, whenBusy: mode })) {
    const submitted = submittedPrompts.get(id) || [];
    submitted.push({ text: before, historyLength });
    submittedPrompts.set(id, submitted);
    if (selectedConversation === id && prompt.value === before) { prompt.value = ''; historyNavigation = undefined; }
    drafts.delete(id); following = true;
  }
}
$('cwd').onclick = () => { if (view) void copyValue('Working directory', view.session.cwd); };
$('session-model').onclick = () => { if (view?.model) void copyValue('Model name', view.model.modelId); };
$('session-name').onclick = () => { if (view) void copyValue('Session name', view.session.name); };
$('composer').onsubmit = event => { event.preventDefault(); void submit(); };
$('follow-up').onclick = () => submit('followUp');
$('abort').onclick = () => run('abort');
$('model').onclick = showModels;
$('sessions').onclick = showSessions;
$('session-search').oninput = filterSessions;
$('new-session').onclick = async () => { if (await run('new-session')) $('session-dialog').close(); };
$('thinking').onclick = () => run('thinking');
$('compact').onclick = () => $('compact-dialog').showModal();
$('compact-form').onsubmit = async event => { event.preventDefault(); if (await run('compact', { instructions: $('compact-instructions').value })) $('compact-dialog').close(); };
$('model-search').oninput = filterModels;
$('help').onclick = () => $('help-dialog').showModal();
$('expand').onclick = () => {
  expanded = !expanded; opened.clear();
  transcript.querySelectorAll('details').forEach(node => { node.open = expanded; });
  $('expand').textContent = `${expanded ? 'Collapse' : 'Expand'} tool details`;
};
$('latest').onclick = () => { following = true; transcript.scrollTop = transcript.scrollHeight; $('latest').hidden = true; };
transcript.onscroll = () => { following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60; $('latest').hidden = following; };
new ResizeObserver(() => { if (following) transcript.scrollTop = transcript.scrollHeight; }).observe(transcript);
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
document.querySelectorAll('[data-suggestion]').forEach(button => { button.onclick = () => { historyNavigation = undefined; prompt.value = button.dataset.suggestion; prompt.focus(); }; });
function navigateHistory(direction) {
  if (!historyNavigation) {
    if (direction > 0 || !view) return false;
    const items = transcriptOf(view).filter(item => item.type === 'user').map(item => item.text);
    // Include accepted prompts that Pi has not yet consumed from its input queue.
    let matched = -1;
    const waiting = [];
    for (const submitted of submittedPrompts.get(selectedConversation) || []) {
      const index = items.findIndex((text, index) => index >= submitted.historyLength && index > matched && text === submitted.text.trim());
      if (index >= 0) matched = index;
      else waiting.push({ ...submitted, historyLength: Math.max(submitted.historyLength, matched + 1) });
    }
    submittedPrompts.set(selectedConversation, waiting);
    items.push(...waiting.map(item => item.text));
    if (!items.length) return false;
    historyNavigation = {
      items, index: items.length, edits: new Map(),
      draft: { text: prompt.value, start: prompt.selectionStart, end: prompt.selectionEnd },
    };
  }
  const history = historyNavigation;
  // Consume the key without rewriting the textarea or moving its caret.
  if (direction < 0 && history.index === 0) return true;
  const column = prompt.selectionStart - (prompt.value.slice(0, prompt.selectionStart).lastIndexOf('\n') + 1);
  if (history.index < history.items.length) history.edits.set(history.index, prompt.value);
  history.index = Math.max(0, Math.min(history.items.length, history.index + direction));
  if (history.index === history.items.length) {
    prompt.value = history.draft.text;
    prompt.setSelectionRange(history.draft.start, history.draft.end);
    historyNavigation = undefined;
  } else {
    prompt.value = history.edits.get(history.index) ?? history.items[history.index];
    const lineStart = direction > 0 ? 0 : prompt.value.lastIndexOf('\n') + 1;
    const newline = prompt.value.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? prompt.value.length : newline;
    const caret = lineStart + Math.min(column, lineEnd - lineStart);
    prompt.setSelectionRange(caret, caret);
  }
  return true;
}
prompt.onkeydown = event => {
  if (event.isComposing) return;
  if (['ArrowUp', 'ArrowDown'].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    // Let the textarea handle movement within the text and collapse selections.
    if (prompt.selectionStart !== prompt.selectionEnd) return;
    const caret = prompt.selectionStart;
    const atBoundary = event.key === 'ArrowUp'
      ? !prompt.value.slice(0, caret).includes('\n')
      : !prompt.value.slice(caret).includes('\n');
    if (!atBoundary) return;
    if (navigateHistory(event.key === 'ArrowUp' ? -1 : 1)) event.preventDefault();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(event.altKey ? 'followUp' : 'steer'); }
};
document.addEventListener('keydown', event => {
  if (event.isComposing || document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') { event.preventDefault(); void run('abort'); }
  if (!event.altKey) return;
  if (event.key.toLowerCase() === 'm') { event.preventDefault(); showModels(); }
  if (event.key.toLowerCase() === 't') { event.preventDefault(); void run('thinking'); }
  if (event.key.toLowerCase() === 'o') { event.preventDefault(); $('expand').click(); }
});
function connection(connected, label) {
  online = connected; $('connection').textContent = label; $('connection-dot').classList.toggle('saved', connected); controls();
}
async function connect() {
  if (!token) { connection(false, 'Launch URL required'); localError = 'Open the full URL printed by the start command, including its #token fragment.'; alerts(); return; }
  let delay = 1000;
  for (;;) {
    let reader;
    try {
      const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401) { connection(false, 'Launch URL expired'); localError = 'Open the new URL printed in the terminal after restarting the server.'; alerts(); return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith('data: ')) continue;
          view = JSON.parse(frame.slice(6)); connection(true, 'Connected'); delay = 1000; render();
        }
      }
    } catch { /* Snapshot reconnect never replays a command. */ }
    finally { await reader?.cancel().catch(() => {}); }
    connection(false, 'Reconnecting…');
    await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(delay * 2, 10000);
  }
}
controls(); void connect();

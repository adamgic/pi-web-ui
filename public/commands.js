import { builtinCommands, parseSlash } from './command-catalog.js';
import { renderChoices } from './picker.js';
import { copyValue } from './copy.js';
import { transcriptOf, usageOf } from './view.js';

const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};

export function createCommands({ prompt, getView, request, showModels, showSessions, report, prose }) {
  const dialog = document.getElementById('command-dialog');
  const title = document.getElementById('command-title');
  const content = document.getElementById('command-content');
  const error = document.getElementById('command-error');
  const suggestions = document.getElementById('command-suggestions');
  let dialogSession, generation = 0, busy = false, active = 0, matches = [], dismissed;
  const catalog = () => getView()?.commands || builtinCommands;
  const fail = problem => { error.textContent = problem.message; error.hidden = false; };
  const close = () => dialog.close();
  dialog.addEventListener('close', () => { if (dialog.open) return; generation++; dialogSession = undefined; prompt.focus(); });
  const open = heading => {
    generation++; busy = false; dialogSession = getView()?.session.id;
    title.textContent = heading; content.replaceChildren(); error.hidden = true;
    if (!dialog.open) dialog.showModal();
    hideSuggestions();
  };
  const send = async (action, payload, sessionId = dialogSession || getView()?.session.id) => {
    if (sessionId !== getView()?.session.id) throw new Error('The active session changed. Open the command again.');
    return request(action, payload, sessionId);
  };
  const act = async callback => {
    if (busy) return;
    busy = true; const version = generation;
    error.hidden = true;
    const buttons = [...content.querySelectorAll('button')];
    const disabled = buttons.map(button => button.disabled);
    buttons.forEach(button => { button.disabled = true; });
    try { await callback(); }
    catch (problem) { if (version === generation) fail(problem); }
    finally {
      if (version === generation) {
        busy = false;
        buttons.forEach((button, index) => { button.disabled = disabled[index]; });
      }
    }
  };
  const button = (label, callback, className = '') => {
    const element = node('button', label, className); element.type = 'button';
    element.onclick = () => void act(callback); return element;
  };
  const paragraph = text => content.append(node('p', text, 'muted'));
  function list(choices, onSelect, { label = 'Filter choices', empty, query = '' } = {}) {
    const input = node('input'); input.type = 'search'; input.id = 'command-search'; input.placeholder = label; input.autocomplete = 'off'; input.value = query;
    const caption = node('label', label); caption.htmlFor = input.id;
    const rows = node('div', undefined, 'model-list'); rows.id = 'command-list';
    const filter = () => renderChoices(rows, choices, { query: input.value, empty, onSelect: item => void act(() => onSelect(item)) });
    input.oninput = filter;
    input.onkeydown = event => {
      if (event.isComposing) return;
      const first = rows.querySelector('button:not(:disabled)');
      if (event.key === 'ArrowDown') { event.preventDefault(); first?.focus(); }
      if (event.key === 'Enter') { event.preventDefault(); first?.click(); }
    };
    rows.onkeydown = event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.isComposing) return;
      const buttons = [...rows.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    content.append(caption, input, rows); filter(); input.focus(); return filter;
  }
  async function load(kind, display) {
    const version = generation;
    paragraph('Loading…');
    try {
      const result = await send('command-data', { kind });
      if (version !== generation || !dialog.open) return;
      content.replaceChildren(); display(result);
    } catch (problem) { if (version === generation) { content.replaceChildren(); fail(problem); } }
  }
  function confirm(heading, description, action, payload = {}) {
    open(heading); paragraph(description);
    content.append(button('Cancel', close), button(heading, async () => { await send(action, payload); close(); }, 'primary'));
  }
  function textInput(heading, label, value, callback) {
    open(heading);
    const form = node('form');
    const input = node('input'); input.id = 'command-input'; input.value = value; input.required = true; input.maxLength = 200;
    const caption = node('label', label); caption.htmlFor = input.id;
    const submit = node('button', 'Save', 'primary'); submit.type = 'submit';
    form.append(caption, input, submit); content.append(form);
    form.onsubmit = event => { event.preventDefault(); void act(async () => { await callback(input.value); close(); }); };
    input.focus(); input.select();
  }
  function terminal(text) {
    open('Continue in Pi terminal');
    paragraph('This command uses Pi’s terminal workflow. Prepare it in the terminal, then press Enter there. The browser remains connected unless the command reloads or shuts down Pi.');
    content.append(node('pre', text));
    content.append(button('Copy command', () => copyValue('Command', text)), button('Prepare in terminal', async () => {
      await send('terminal-command', { text });
      paragraph('Ready in Pi’s terminal. Press Enter there to continue.');
    }, 'primary'));
  }
  function showCommands() {
    open('Slash commands');
    paragraph('Choose a command, or type / in the composer. Commands marked “Pi terminal” use its interactive workflow.');
    list(catalog().map(item => ({ value: item.name, title: `/${item.name} ${item.argumentsHint || ''}`.trim(), description: `${item.description}${item.mode === 'terminal' ? ' · Pi terminal' : item.mode === 'prompt' ? ' · Sends a prompt' : ''}` })), async item => {
      close();
      const descriptor = catalog().find(command => command.name === item.value);
      if (descriptor.mode === 'prompt') { prompt.value = `/${item.value} `; prompt.focus(); }
      else await execute(`/${item.value}`);
    }, { label: 'Filter commands' });
  }
  function sessionInfo() {
    open('Session information');
    const view = getView(), usage = usageOf(view);
    const rows = [['Name', view.session.name], ['Session ID', view.session.id], ['Working directory', view.session.cwd], ['Session file', view.session.file || 'In memory'], ['Model', view.model ? `${view.model.provider}/${view.model.modelId}` : 'None'], ['Thinking', view.thinkingLevel], ['Messages', transcriptOf(view).filter(item => ['user', 'assistant'].includes(item.type)).length], ['Input tokens', usage.input], ['Output tokens', usage.output], ['Cache read', usage.cacheRead], ['Cache write', usage.cacheWrite], ['Cost', `$${usage.cost.toFixed(3)}`]];
    const details = node('dl', undefined, 'metadata');
    for (const [key, value] of rows) details.append(node('dt', key), node('dd', String(value)));
    content.append(details);
  }
  async function tree(kind) {
    open(kind === 'fork' ? 'Fork from a user message' : 'Session tree');
    await load('tree', data => {
      paragraph(kind === 'fork' ? 'Create a new session before the selected user message. The original session is preserved.' : 'Choose an entry to make it the current branch. Other branches are preserved.');
      const summarize = node('input'); summarize.type = 'checkbox'; summarize.id = 'tree-summarize';
      if (kind === 'tree') {
        const label = node('label', 'Summarize the branch being left (uses the model)'); label.className = 'command-check'; label.prepend(summarize); content.append(label);
      }
      const byId = new Map(data.entries.map(entry => [entry.id, entry]));
      const depth = entry => { const visited = new Set(); let count = 0; while (entry?.parentId && !visited.has(entry.parentId)) { visited.add(entry.parentId); entry = byId.get(entry.parentId); count++; } return count; };
      list(data.entries.filter(entry => kind !== 'fork' || entry.role === 'user').map(entry => ({
        value: entry.id, title: `${'· '.repeat(Math.min(depth(entry), 8))}${entry.label || entry.text || entry.type}`,
        description: `${entry.role || entry.type} · ${entry.id}${entry.id === data.leafId ? ' · Current' : ''}`,
        selected: entry.id === data.leafId, disabled: kind === 'tree' && entry.id === data.leafId,
      })), async item => { await send(kind, { entryId: item.value, summarize: summarize.checked }); close(); }, { label: 'Filter session entries', empty: 'No entries available yet.' });
    });
  }
  async function tools() {
    open('Available tools');
    await load('tools', data => {
      paragraph('Choose the tools declared to the model. Deferred tools may remain callable through Pi’s tool search.');
      const selected = new Set(data.active);
      const choices = data.tools.map(tool => ({ value: tool.name, title: tool.name, description: tool.description, selected: selected.has(tool.name) }));
      const refresh = list(choices, item => { selected.has(item.value) ? selected.delete(item.value) : selected.add(item.value); item.selected = selected.has(item.value); refresh(); }, { label: 'Filter tools' });
      content.append(button('Apply tool selection', async () => { await send('tools', { tools: [...selected] }); close(); }, 'primary'));
    });
  }
  function download(filename, type, data) {
    const link = node('a'); const url = URL.createObjectURL(new Blob([data], { type }));
    link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportSession(filename) {
    open('Export session');
    const view = getView();
    paragraph('Download HTML for the current conversation branch, or JSONL for the complete session tree. Files are saved by your browser.');
    const save = async extension => {
      const name = (filename || `pi-session-${view.session.id}.${extension}`).split(/[\\/]/).at(-1);
      if (!name || !/\.(html|jsonl)$/i.test(name)) throw new Error('Choose a filename ending in .html or .jsonl.');
      if (name.toLowerCase().endsWith('.jsonl')) {
        const data = await send('command-data', { kind: 'export' });
        download(name, 'application/x-ndjson', [data.header, ...data.entries].filter(Boolean).map(entry => JSON.stringify(entry)).join('\n') + '\n');
      } else {
        const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
        const messages = transcriptOf(view).map(item => `<article><h2>${escape(item.name || item.type)}</h2><pre>${escape([item.thinking, item.text, item.output, item.args && JSON.stringify(item.args, null, 2)].filter(Boolean).join('\n\n'))}</pre></article>`).join('\n');
        download(name, 'text/html', `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(view.session.name)}</title><style>body{font:16px/1.6 system-ui;max-width:900px;margin:40px auto;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid #aaa}</style><h1>${escape(view.session.name)}</h1>${messages}`);
      }
      paragraph(`Downloaded ${name}.`);
    };
    if (filename) content.append(button(`Download ${filename.split(/[\\/]/).at(-1)}`, () => save('html'), 'primary'));
    else content.append(button('Download HTML', () => save('html'), 'primary'), button('Download JSONL', () => save('jsonl')));
  }
  async function execute(text, whenBusy = 'steer') {
    const parsed = parseSlash(text);
    if (!parsed) return false;
    const { name, args } = parsed;
    if (!name) { showCommands(); return true; }
    const descriptor = catalog().find(item => item.name === name);
    if (!descriptor) throw new Error(`Unknown command /${name}. Use /help to see available commands.`);
    if (descriptor.mode === 'prompt') { await send('slash', { text, whenBusy }, getView()?.session.id); return true; }
    if (descriptor.mode === 'terminal') {
      if (name === 'login' && !args) {
        open('Choose a provider');
        await load('providers', data => list(data.providers.map(provider => ({ value: provider.id, title: provider.name, description: provider.id })), item => terminal(`/login ${item.value}`), { label: 'Filter providers' }));
      } else terminal(text);
      return true;
    }
    if (args && !['model', 'thinking', 'name', 'compact', 'export'].includes(name)) throw new Error(`/${name} does not accept arguments.`);
    switch (name) {
      case 'help': showCommands(); break;
      case 'hotkeys': document.getElementById('help-dialog').showModal(); break;
      case 'model': await showModels(args); break;
      case 'thinking':
        if (args) await send('thinking', { level: args }, getView()?.session.id);
        else {
          open('Thinking level');
          list(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(value => ({ value, title: value, selected: value === getView()?.thinkingLevel })), async item => { await send('thinking', { level: item.value }); close(); }, { label: 'Filter thinking levels' });
        }
        break;
      case 'new': confirm('New session', 'Start a new conversation. Pi preserves your saved session.', 'new-session'); break;
      case 'resume': await showSessions(); break;
      case 'tree': case 'fork': await tree(name); break;
      case 'clone': confirm('Clone session', 'Create a copy through the current entry. The original session is preserved.', 'clone'); break;
      case 'name':
        if (args) await send('name', { name: args }, getView()?.session.id);
        else textInput('Rename session', 'Session name', getView()?.session.name || '', value => send('name', { name: value }));
        break;
      case 'session': sessionInfo(); break;
      case 'compact':
        if (args) await send('compact', { instructions: args }, getView()?.session.id);
        else document.getElementById('compact-dialog').showModal();
        break;
      case 'abort': await send('abort', {}, getView()?.session.id); break;
      case 'copy': {
        const text = transcriptOf(getView()).filter(item => item.type === 'assistant' && item.text).at(-1)?.text;
        if (!text) throw new Error('No assistant response to copy yet.');
        await copyValue('Response Markdown', text); break;
      }
      case 'export': await exportSession(args); break;
      case 'tools': await tools(); break;
      case 'settings':
        open('Pi settings');
        await load('settings', data => {
          paragraph('Effective settings for this session. Use Pi’s settings menu to change them.');
          list(data.settings.map(item => ({ value: item.name, title: item.name, description: String(item.value), disabled: true })), () => {}, { label: 'Filter settings', empty: 'Pi is using its default settings.' });
          content.append(button('Edit in Pi terminal', () => terminal('/settings')));
        }); break;
      case 'scoped-models':
        open('Model cycle');
        await load('scoped-models', data => {
          paragraph('Models included in Pi’s terminal model cycle. Choose one here or change the cycle in Pi.');
          list(data.models.map(model => ({ value: `${model.provider}/${model.modelId}`, title: model.name, description: `${model.provider}/${model.modelId} · ${model.thinkingLevel || 'default thinking'}`, model })), async item => { await send('model', { provider: item.model.provider, modelId: item.model.modelId }); close(); }, { label: 'Filter scoped models', empty: 'No scope configured. All available models can be used.' });
          content.append(button('Configure in Pi terminal', () => terminal('/scoped-models')));
        }); break;
      case 'changelog': open('Pi changelog'); await load('changelog', data => content.append(prose(data.text))); break;
      case 'quit': confirm('Quit Pi', 'This stops Pi and disconnects every browser tab attached to this web server.', 'quit', { confirm: true }); break;
    }
    return true;
  }
  function hideSuggestions() {
    suggestions.hidden = true; prompt.setAttribute('aria-expanded', 'false'); prompt.removeAttribute('aria-activedescendant');
  }
  function complete(item) {
    prompt.value = `/${item.name} `; dismissed = prompt.value; hideSuggestions(); prompt.focus();
  }
  function updateSuggestions() {
    const parsed = parseSlash(prompt.value);
    if (!parsed || parsed.args || /\s/.test(prompt.value.trimStart()) || document.activeElement !== prompt || dismissed === prompt.value || dialog.open || !getView()) { hideSuggestions(); return; }
    matches = catalog().filter(item => item.name.startsWith(parsed.name));
    if (!matches.length) { hideSuggestions(); return; }
    active = Math.min(active, matches.length - 1);
    const buttons = renderChoices(suggestions, matches.map(item => ({ value: item.name, title: `/${item.name}`, description: `${item.description}${item.mode === 'terminal' ? ' · Pi terminal' : ''}` })), { onSelect: item => complete(matches.find(match => match.name === item.value)) });
    buttons.forEach((button, index) => {
      button.id = `slash-option-${index}`; button.tabIndex = -1; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === active));
      button.onmousedown = event => event.preventDefault();
    });
    suggestions.hidden = false; prompt.setAttribute('aria-expanded', 'true'); prompt.setAttribute('aria-activedescendant', buttons[active].id);
    buttons[active].scrollIntoView({ block: 'nearest' });
  }
  function keydown(event) {
    if (event.isComposing || suggestions.hidden || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
    if (event.key === 'Escape') { dismissed = prompt.value; hideSuggestions(); event.preventDefault(); event.stopPropagation(); return true; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      updateSuggestions(); event.preventDefault(); return true;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && parseSlash(prompt.value)?.name !== matches[active]?.name)) {
      complete(matches[active]); event.preventDefault(); return true;
    }
    hideSuggestions(); return false;
  }
  prompt.addEventListener('input', () => { active = 0; dismissed = undefined; updateSuggestions(); });
  prompt.addEventListener('focus', updateSuggestions);
  prompt.addEventListener('blur', hideSuggestions);
  return {
    execute, showCommands, keydown, hideSuggestions,
    update() {
      if (dialog.open && dialogSession !== getView()?.session.id) close();
      updateSuggestions();
    },
    async submit(text, mode) { try { return await execute(text, mode); } catch (problem) { report(problem.message); return false; } },
  };
}

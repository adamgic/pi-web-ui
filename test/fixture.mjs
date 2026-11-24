export function fixture() {
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map();
  const state = { id: 'test-session', name: 'Test session', entries: [], idle: true, pending: false, thinking: 'off', calls: [], notices: [], editor: '', activeTools: ['read', 'bash'],
    model: { provider: 'test', id: 'faux', name: 'Faux model', contextWindow: 32000 } };
  const ctx = {
    mode: 'tui', cwd: '/example/project', get model() { return state.model; },
    sessionManager: { getHeader: () => ({ type: 'session', version: 3, id: state.id, timestamp: '2026-10-21T10:00:00Z', cwd: '/example/project' }), getSessionId: () => state.id, getSessionFile: () => '/example/session.jsonl', getSessionDir: () => '/example', getBranch: () => state.entries, getEntries: () => state.entries, getLeafId: () => state.entries.at(-1)?.id, getLabel: () => undefined },
    modelRegistry: { getAvailable: () => [state.model] },
    isIdle: () => state.idle, hasPendingMessages: () => state.pending, getContextUsage: () => ({ tokens: 100, contextWindow: 32000 }),
    abort: () => state.calls.push(['abort']),
    compact: options => { state.calls.push(['compact', options.customInstructions]); state.compaction = options; },
    shutdown: () => state.calls.push(['shutdown']),
    ui: { notify: (text, level) => state.notices.push({ text, level }), getEditorText: () => state.editor, setEditorText: text => { state.editor = text; } },
  };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, options) => { if (!flags.has(name)) flags.set(name, options.default); },
    getFlag: name => flags.get(name), getSessionName: () => state.name, setSessionName: name => { state.name = name; }, getActiveTools: () => state.activeTools,
    getCommands: () => [...commands].map(([name, command]) => ({ name, description: command.description, source: 'extension' })),
    getAllTools: () => [{ name: 'read', description: 'Read files' }, { name: 'bash', description: 'Run shell commands' }],
    setActiveTools: names => { state.activeTools = names; }, getSettings: () => ({ defaultProvider: 'test', defaultModel: 'faux', compaction: { enabled: true } }),
    getThinkingLevel: () => state.thinking, setThinkingLevel: level => { state.thinking = level; },
    setModel: async model => { state.calls.push(['model', model.id]); return true; },
    sendUserMessage: (text, options) => state.calls.push(['submit', text, options.deliverAs]),
  };
  return { state, ctx, pi, flags, commands, handlers, async emit(type, fields = {}) { await handlers.get(type)?.({ type, ...fields }, ctx); } };
}

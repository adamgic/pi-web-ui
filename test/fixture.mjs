export function fixture() {
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map();
  const state = { id: 'test-session', entries: [], idle: true, pending: false, thinking: 'off', calls: [], notices: [],
    model: { provider: 'test', id: 'faux', name: 'Faux model', contextWindow: 32000 } };
  const ctx = {
    mode: 'tui', cwd: '/example/project', get model() { return state.model; },
    sessionManager: { getSessionId: () => state.id, getSessionFile: () => '/example/session.jsonl', getSessionDir: () => '/example', getBranch: () => state.entries },
    modelRegistry: { getAvailable: () => [state.model] },
    isIdle: () => state.idle, hasPendingMessages: () => state.pending, getContextUsage: () => ({ tokens: 100, contextWindow: 32000 }),
    abort: () => state.calls.push(['abort']),
    compact: options => { state.calls.push(['compact', options.customInstructions]); state.compaction = options; },
    ui: { notify: (text, level) => state.notices.push({ text, level }) },
  };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, options) => { if (!flags.has(name)) flags.set(name, options.default); },
    getFlag: name => flags.get(name), getSessionName: () => 'Test session', getActiveTools: () => ['read', 'bash'],
    getThinkingLevel: () => state.thinking, setThinkingLevel: level => { state.thinking = level; },
    setModel: async model => { state.calls.push(['model', model.id]); return true; },
    sendUserMessage: (text, options) => state.calls.push(['submit', text, options.deliverAs]),
  };
  return { state, ctx, pi, flags, commands, handlers, async emit(type, fields = {}) { await handlers.get(type)?.({ type, ...fields }, ctx); } };
}

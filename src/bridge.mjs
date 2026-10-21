import { homedir } from 'node:os';
import { sep } from 'node:path';
import { textContent } from '../public/view.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const copy = value => structuredClone(value);

/** Adapts the public ExtensionAPI and ExtensionContext to browser snapshots. */
export function createBridge(pi, { listSessions: discoverSessions = async () => [], changeSession } = {}) {
  let ctx;
  let streaming;
  let completed = [];
  let tools = new Map();
  let compacting = false;
  let closed = true;
  let notices = [];
  const listeners = new Set();
  const publish = () => { for (const listener of listeners) listener(); };
  const notice = message => { notices = [...notices.slice(-2), { level: 'error', message }]; publish(); };

  function update(event, context) {
    if (event.type === 'session_start' || ctx?.sessionManager.getSessionId() !== context.sessionManager.getSessionId()) {
      streaming = undefined; completed = []; tools = new Map(); compacting = false; notices = []; closed = false;
    }
    ctx = context;
    if (event.type === 'agent_start') { tools.clear(); notices = []; }
    if (event.type === 'message_start' || event.type === 'message_update') streaming = copy(event.message);
    if (event.type === 'message_end') {
      // Pi emits this event before appending the message to its session file.
      if (['user', 'assistant', 'system', 'toolResult', 'custom'].includes(event.message.role)) completed.push(copy(event.message));
      streaming = undefined;
    }
    if (event.type.startsWith('tool_execution_')) {
      const result = event.partialResult ?? event.result;
      const prior = tools.get(event.toolCallId);
      tools.set(event.toolCallId, {
        callId: event.toolCallId, name: event.toolName, args: event.args ?? prior?.args,
        status: event.type === 'tool_execution_end' ? (event.isError ? 'error' : 'done') : 'running',
        output: result ? textContent(result.content).slice(-64000) : prior?.output,
      });
      if (tools.size > 200) tools.delete(tools.keys().next().value);
    }
    if (event.type === 'session_compact' || event.type === 'session_compact_failed') compacting = false;
    if (event.type === 'session_tree') { streaming = undefined; completed = []; tools.clear(); }
    if (event.type === 'agent_settled') streaming = undefined;
    publish();
  }

  function current() {
    if (!ctx || closed) throw fail(503, 'No active Pi session.');
    const entries = ctx.sessionManager.getBranch().filter(entry => ['message', 'custom_message', 'compaction', 'branch_summary'].includes(entry.type));
    // Retain a just-finished message only until Pi persists it. No synthetic history is saved.
    completed = completed.filter(message => !entries.some(entry =>
      (entry.type === 'message' && JSON.stringify(entry.message) === JSON.stringify(message)) ||
      (entry.type === 'custom_message' && message.role === 'custom' && entry.customType === message.customType && JSON.stringify(entry.content) === JSON.stringify(message.content))));
    const models = ctx.modelRegistry.getAvailable().map(model => ({ provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow }));
    const home = homedir();
    const displayCwd = ctx.cwd === home ? '~' : ctx.cwd.startsWith(home + sep) ? '~' + ctx.cwd.slice(home.length) : ctx.cwd;
    const firstPrompt = entries.find(entry => entry.type === 'message' && entry.message.role === 'user')?.message;
    return {
      session: { displayCwd, created: ctx.sessionManager.getHeader()?.timestamp, id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, file: ctx.sessionManager.getSessionFile(), name: pi.getSessionName() || textContent(firstPrompt?.content).trim().slice(0, 160) || 'New session' },
      entries, completed, streaming, tools: [...tools.values()], models,
      model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
      thinkingLevel: pi.getThinkingLevel(), busy: !ctx.isIdle(), compacting,
      pendingMessages: ctx.hasPendingMessages(), context: ctx.getContextUsage(),
      activeTools: pi.getActiveTools(), notices,
    };
  }

  async function listSessions() {
    if (!ctx || closed) throw fail(503, 'No active Pi session.');
    const id = ctx.sessionManager.getSessionId();
    const sessions = await discoverSessions(ctx.cwd, ctx.sessionManager.getSessionDir());
    if (closed || id !== ctx.sessionManager.getSessionId()) throw fail(409, 'The active session changed.');
    return { sessionId: id, sessions: sessions.map(item => ({
      id: item.id, path: item.path, name: (item.name || item.firstMessage || 'Untitled session').slice(0, 160),
      modified: item.modified, messageCount: item.messageCount,
    })) };
  }

  async function execute(command) {
    if (closed || !ctx) throw fail(503, 'No active Pi session.');
    if (command.sessionId !== ctx.sessionManager.getSessionId()) throw fail(409, 'The active session changed. Review it before retrying.');
    switch (command.action) {
      case 'new-session':
      case 'switch-session': {
        if (!changeSession) throw fail(503, 'Session controls are unavailable.');
        if (!ctx.isIdle() || compacting || ctx.hasPendingMessages()) throw fail(409, 'Wait until Pi is idle before changing sessions.');
        let path;
        if (command.action === 'switch-session') {
          const { sessions } = await listSessions();
          path = sessions.find(session => session.path === command.path)?.path;
          if (!path) throw fail(400, 'Session unavailable in this working directory.');
        }
        // Context may have changed during discovery. Never act on a stale browser request.
        if (command.sessionId !== ctx.sessionManager.getSessionId() || !ctx.isIdle() || ctx.hasPendingMessages() || compacting) throw fail(409, 'Session state changed. Try again when idle.');
        return changeSession({ action: command.action, path, sessionId: command.sessionId });
      }
      case 'submit': {
        if (typeof command.text !== 'string' || !command.text.trim()) throw fail(400, 'Enter a message.');
        if (!['steer', 'followUp'].includes(command.whenBusy)) throw fail(400, 'Invalid queue mode.');
        // Built-in CLI commands are not dispatched by sendUserMessage. Never send them to the model accidentally.
        if (command.text.trim().startsWith('/')) throw fail(400, 'Use /model, /thinking, /compact, /abort or /help in the browser. Run other Pi commands in the terminal.');
        if (!ctx.model || !ctx.modelRegistry.getAvailable().some(model => model.provider === ctx.model.provider && model.id === ctx.model.id)) {
          throw fail(400, 'Choose an authenticated model. Run /login in the Pi terminal if needed.');
        }
        if (compacting) throw fail(409, 'Wait for compaction to finish.');
        pi.sendUserMessage(command.text.trim(), { deliverAs: command.whenBusy });
        break;
      }
      case 'abort': ctx.abort(); break;
      case 'compact': {
        if (!ctx.isIdle() || compacting || ctx.hasPendingMessages()) throw fail(409, 'Wait until Pi is idle before compacting.');
        if (command.instructions !== undefined && typeof command.instructions !== 'string') throw fail(400, 'Invalid compaction instructions.');
        compacting = true;
        try {
          ctx.compact({ customInstructions: command.instructions || undefined,
            onComplete: () => { compacting = false; publish(); },
            onError: error => { compacting = false; notice(error.message); },
          });
        } catch (error) { compacting = false; throw error; }
        break;
      }
      case 'model': {
        if (!ctx.isIdle() || compacting) throw fail(409, 'Wait until Pi is idle before changing models.');
        const model = ctx.modelRegistry.getAvailable().find(model => model.provider === command.provider && model.id === command.modelId);
        if (!model) throw fail(400, 'Model unavailable. Authenticate with /login in the Pi terminal.');
        if (!await pi.setModel(model)) throw fail(400, 'Authentication is not configured for this model.');
        break;
      }
      case 'thinking': {
        const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
        pi.setThinkingLevel(levels[(levels.indexOf(pi.getThinkingLevel()) + 1) % levels.length]);
        break;
      }
      default: throw fail(400, 'Unknown command.');
    }
    publish();
    return { accepted: true };
  }
  return { update, current, execute, listSessions, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { closed = true; listeners.clear(); streaming = undefined; completed = []; tools.clear(); },
  };
}

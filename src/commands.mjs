import { commandCatalog, parseSlash } from '../public/command-catalog.js';
import { textContent } from '../public/view.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const commandsFor = pi => commandCatalog(pi.getCommands?.() || []);

// All mutations use Pi's public extension API. Terminal-only built-ins are
// staged in its editor, never submitted to the language model.
export async function executeCommand(command, { pi, ctx, compacting, changeSession, readChangelog }) {
  const idle = () => {
    if (!ctx.isIdle() || compacting || ctx.hasPendingMessages()) throw fail(409, 'Wait until Pi is idle before using this command.');
  };
  const entries = () => ctx.sessionManager.getEntries?.() || ctx.sessionManager.getBranch();
  switch (command.action) {
    case 'command-data': {
      switch (command.kind) {
        case 'tree': return { leafId: ctx.sessionManager.getLeafId?.(), entries: entries().map(entry => ({
          id: entry.id, parentId: entry.parentId, type: entry.type, role: entry.message?.role,
          label: ctx.sessionManager.getLabel?.(entry.id), timestamp: entry.timestamp,
          text: (entry.message ? textContent(entry.message.content) : entry.summary || entry.name || entry.type).slice(0, 240),
        })) };
        case 'tools': return { tools: (pi.getAllTools?.() || []).filter(tool => tool.exposure !== 'hidden').map(({ name, description }) => ({ name, description })), active: pi.getActiveTools() };
        case 'settings': {
          const settings = pi.getSettings?.() || {};
          // Never serialize arbitrary configuration: providers may contain credentials.
          const paths = ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'steeringMode', 'followUpMode', 'compaction.enabled', 'compaction.reserveTokens', 'compaction.keepRecentTokens', 'retry.enabled', 'retry.maxRetries', 'theme'];
          return { settings: paths.flatMap(name => {
            const value = name.split('.').reduce((value, key) => value?.[key], settings);
            return ['string', 'number', 'boolean'].includes(typeof value) ? [{ name, value }] : [];
          }) };
        }
        case 'scoped-models': return { models: (ctx.scopedModels || []).map(({ model, thinkingLevel }) => ({ provider: model.provider, modelId: model.id, name: model.name, thinkingLevel })) };
        case 'providers': return { providers: [...new Set((ctx.modelRegistry.getAll?.() || ctx.modelRegistry.getAvailable()).map(model => model.provider))].sort().map(id => ({ id, name: ctx.modelRegistry.getProviderDisplayName?.(id) || id })) };
        case 'export': return { header: ctx.sessionManager.getHeader(), entries: entries() };
        case 'changelog': {
          if (!readChangelog) throw fail(503, 'Changelog is unavailable in this Pi installation.');
          return { text: await readChangelog() };
        }
        default: throw fail(400, 'Unknown command view.');
      }
    }
    case 'name': {
      if (typeof command.name !== 'string' || !command.name.trim() || command.name.length > 200) throw fail(400, 'Enter a session name of 1–200 characters.');
      pi.setSessionName(command.name.trim()); break;
    }
    case 'tools': {
      idle();
      const known = new Set((pi.getAllTools?.() || []).filter(tool => tool.exposure !== 'hidden').map(tool => tool.name));
      if (!Array.isArray(command.tools) || command.tools.some(name => !known.has(name))) throw fail(400, 'Unknown tool selection.');
      pi.setActiveTools([...new Set(command.tools)]); break;
    }
    case 'tree':
    case 'fork':
    case 'clone': {
      idle();
      if (!changeSession) throw fail(503, 'Session controls are unavailable.');
      const entryId = command.action === 'clone' ? ctx.sessionManager.getLeafId?.() : command.entryId;
      const entry = entries().find(entry => entry.id === entryId);
      if (!entry || (command.action === 'fork' && (entry.type !== 'message' || entry.message.role !== 'user'))) throw fail(400, 'Choose an available session entry.');
      if (command.summarize !== undefined && typeof command.summarize !== 'boolean') throw fail(400, 'Invalid summary option.');
      return changeSession({ action: command.action, entryId, sessionId: command.sessionId, summarize: command.summarize === true });
    }
    case 'slash': {
      const parsed = typeof command.text === 'string' && parseSlash(command.text);
      const descriptor = parsed && commandsFor(pi).find(item => item.name === parsed.name);
      if (!descriptor || descriptor.mode !== 'prompt') throw fail(400, 'Choose a known prompt or skill. Built-in commands cannot be sent as prompts.');
      if (!['steer', 'followUp'].includes(command.whenBusy)) throw fail(400, 'Invalid queue mode.');
      if (compacting) throw fail(409, 'Wait for compaction to finish.');
      if (!ctx.model || !ctx.modelRegistry.getAvailable().some(model => model.provider === ctx.model.provider && model.id === ctx.model.id)) throw fail(400, 'Choose an authenticated model first.');
      pi.sendUserMessage(command.text.trim(), { deliverAs: command.whenBusy, expandPromptTemplates: true }); break;
    }
    case 'terminal-command': {
      idle();
      const parsed = typeof command.text === 'string' && parseSlash(command.text);
      const descriptor = parsed && commandsFor(pi).find(item => item.name === parsed.name);
      if (!descriptor || (descriptor.mode !== 'terminal' && !['settings', 'scoped-models'].includes(parsed.name)) || /[\x00-\x1f\x7f]/.test(command.text)) throw fail(400, 'Choose a valid single-line Pi command.');
      if (!ctx.ui.setEditorText) throw fail(503, 'Pi’s terminal editor is unavailable. Copy the command instead.');
      if (ctx.ui.getEditorText?.().trim()) throw fail(409, 'The terminal has an unfinished draft. Clear it there, or copy this command.');
      ctx.ui.setEditorText(command.text.trim());
      ctx.ui.notify('Command prepared by the web UI. Press Enter here to run it.', 'info'); break;
    }
    case 'quit': {
      idle();
      if (command.confirm !== true) throw fail(400, 'Confirm shutting down Pi.');
      // Let the HTTP receipt reach the browser before session_shutdown closes it.
      setTimeout(() => ctx.shutdown(), 150); break;
    }
    default: throw fail(400, 'Unknown command.');
  }
  return { accepted: true };
}

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createBridge } from './bridge.mjs';
import { startServer } from './server.mjs';
import { createTransport, handoffs } from './transport.mjs';

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Browser launcher exited with ${code}.`)));
  });
}

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function webUI(pi, { listSessions } = {}) {
  const requests = new Map();
  let transferring = false;
  const bridge = createBridge(pi, { listSessions, changeSession: request => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => { requests.delete(id); reject(new Error('Pi did not handle the session command.')); }, 15000);
    requests.set(id, { ...request, resolve, reject, timeout });
    try { pi.sendUserMessage(`/web-session ${id}`, { expandPromptTemplates: true }); }
    catch (error) { clearTimeout(timeout); requests.delete(id); reject(error); }
  }) });
  let transport = createTransport(bridge);
  let web;
  let starting;
  let generation = 0;
  pi.registerFlag('web-ui', { type: 'boolean', default: false, description: 'Start the browser UI with this Pi session' });
  pi.registerFlag('web-ui-port', { type: 'string', default: '0', description: 'Local browser port (0 selects a free port)' });
  pi.registerFlag('web-ui-no-open', { type: 'boolean', default: false, description: 'Print the browser URL without opening it' });

  async function stop() {
    generation++;
    if (starting) await starting;
    web = undefined;
    await transport.close();
  }
  async function start(ctx, open = true) {
    if (!web) {
      if (!starting) {
        const version = generation;
        starting = (async () => {
          const raw = String(pi.getFlag('web-ui-port') ?? '0');
          if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error('web-ui-port must be an integer from 0 to 65535.');
          transport.attach(bridge);
          const server = await startServer(transport, { port: Number(raw) });
          if (generation !== version) { await server.close(); return; }
          web = server;
          transport.server = server;
        })().finally(() => { starting = undefined; });
      }
      await starting;
    }
    if (!web) return;
    ctx.ui.notify(`Pi Web UI: ${web.url}`, 'info');
    if (open && !pi.getFlag('web-ui-no-open')) {
      try { await openBrowser(web.url); }
      catch (error) { ctx.ui.notify(`Could not open the browser: ${error.message} Open the URL above manually.`, 'warning'); }
    }
  }

  pi.registerCommand('web', {
    description: 'Open the browser UI (/web url to show URL, /web stop to close server)',
    handler: async (args, ctx) => {
      try {
        const action = args.trim();
        if (action.startsWith('attach ')) {
          const id = action.slice(7);
          const transfer = handoffs.get(id);
          if (!transfer) throw new Error('Session handoff expired.');
          await stop();
          transport = transfer.transport;
          transport.attach(bridge);
          web = transport.server;
          handoffs.delete(id);
          return;
        }
        if (action === 'stop') { await stop(); ctx.ui.notify('Web UI stopped.', 'info'); return; }
        if (!['', 'open', 'url'].includes(action)) { ctx.ui.notify('Usage: /web [open|url|stop]', 'warning'); return; }
        await start(ctx, action !== 'url');
      } catch (error) { ctx.ui.notify(`Web UI: ${error.message}`, 'error'); }
    },
  });
  // Dispatch via a registered command to obtain Pi's command-capable context.
  // Only browser requests registered above can invoke a session change here.
  pi.registerCommand('web-session', {
    description: 'Internal browser session control',
    handler: async (id, ctx) => {
      const request = requests.get(id.trim());
      if (!request) { ctx.ui.notify('Use the browser session picker or /web.', 'warning'); return; }
      clearTimeout(request.timeout);
      requests.delete(id.trim());
      const transferId = randomUUID();
      let replaced = false;
      try {
        if (ctx.sessionManager.getSessionId() !== request.sessionId || !ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Session state changed. Try again when idle.');
        handoffs.set(transferId, { transport, previousFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd });
        transport.freeze();
        transferring = true;
        const options = { withSession: async next => {
          replaced = true;
          await next.sendUserMessage(`/web attach ${transferId}`, { expandPromptTemplates: true });
          if (handoffs.has(transferId)) throw new Error('The new session could not attach the Web UI extension.');
        } };
        const result = request.action === 'new-session' ? await ctx.newSession(options) : await ctx.switchSession(request.path, options);
        if (result.cancelled) {
          transport.attach(bridge);
          request.reject(Object.assign(new Error('Session change cancelled by Pi.'), { status: 409 }));
        } else request.resolve({ accepted: true });
      } catch (error) {
        // Once replaced, the old bridge/context must never be used again.
        if (replaced || bridgeClosed) await transport.close();
        else transport.attach(bridge);
        request.reject(error);
      } finally {
        transferring = false;
        handoffs.delete(transferId);
      }
    },
  });
  let bridgeClosed = false;
  pi.on('session_start', async (event, ctx) => {
    bridgeClosed = false;
    bridge.update(event, ctx);
    if (['new', 'resume'].includes(event.reason) && [...handoffs.values()].some(item => item.previousFile === event.previousSessionFile && item.cwd === ctx.cwd)) return;
    if (pi.getFlag('web-ui') && ctx.mode === 'tui') {
      try { await start(ctx); } catch (error) { ctx.ui.notify(`Web UI: ${error.message}`, 'error'); }
    }
  });
  for (const event of ['agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'model_select', 'thinking_level_select',
    'session_compact', 'session_compact_failed', 'session_tree', 'session_info_changed']) {
    pi.on(event, (event, ctx) => { bridge.update(event, ctx); });
  }
  pi.on('session_shutdown', async () => {
    bridgeClosed = true;
    if (!transferring) await stop();
    bridge.close();
  });
}

import { spawn } from 'node:child_process';
import { createBridge } from './bridge.mjs';
import { startServer } from './server.mjs';

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
export default function webUI(pi) {
  const bridge = createBridge(pi);
  let web;
  let starting;
  let generation = 0;
  pi.registerFlag('web-ui', { type: 'boolean', default: false, description: 'Start the browser UI with this Pi session' });
  pi.registerFlag('web-ui-port', { type: 'string', default: '0', description: 'Local browser port (0 selects a free port)' });
  pi.registerFlag('web-ui-no-open', { type: 'boolean', default: false, description: 'Print the browser URL without opening it' });

  async function stop() {
    generation++;
    if (starting) await starting;
    const server = web; web = undefined;
    await server?.close();
  }
  async function start(ctx, open = true) {
    if (!web) {
      if (!starting) {
        const version = generation;
        starting = (async () => {
          const raw = String(pi.getFlag('web-ui-port') ?? '0');
          if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error('web-ui-port must be an integer from 0 to 65535.');
          const server = await startServer(bridge, { port: Number(raw) });
          if (generation !== version) { await server.close(); return; }
          web = server;
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
        if (action === 'stop') { await stop(); ctx.ui.notify('Web UI stopped.', 'info'); return; }
        if (!['', 'open', 'url'].includes(action)) { ctx.ui.notify('Usage: /web [open|url|stop]', 'warning'); return; }
        await start(ctx, action !== 'url');
      } catch (error) { ctx.ui.notify(`Web UI: ${error.message}`, 'error'); }
    },
  });
  pi.on('session_start', async (event, ctx) => {
    bridge.update(event, ctx);
    if (pi.getFlag('web-ui') && ctx.mode === 'tui') {
      try { await start(ctx); } catch (error) { ctx.ui.notify(`Web UI: ${error.message}`, 'error'); }
    }
  });
  for (const event of ['agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'model_select', 'thinking_level_select',
    'session_compact', 'session_compact_failed', 'session_tree', 'session_info_changed']) {
    pi.on(event, (event, ctx) => { bridge.update(event, ctx); });
  }
  pi.on('session_shutdown', async () => { await stop(); bridge.close(); });
}

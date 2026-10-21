import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath, stat, readFile } from 'node:fs/promises';

import { resolve } from 'node:path';
import { homedir } from 'node:os';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/preview.html', ['preview.html', 'text/html; charset=utf-8']],
  ['/preview.js', ['preview.js', 'text/javascript; charset=utf-8']],
  ['/preview.css', ['preview.css', 'text/css; charset=utf-8']],
  ['/prose.js', ['prose.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/view.js', ['view.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const policy = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function error(status, message) { return Object.assign(new Error(message), { status }); }
async function body(req) {
  if (req.headers['content-type'] !== 'application/json') throw error(415, 'Expected application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw error(413, 'Command exceeds 256 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error(400, 'Invalid JSON.'); }
}

/** Local authenticated transport for the active Pi session. */
export async function startServer(bridge, { port = 0 } = {}) {
  const token = randomBytes(32).toString('hex');
  const clients = new Set();
  const receipts = new Map();
  let origin;
  let timer;
  let queue = Promise.resolve();
  let closing = false;
  let closePromise;
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const authorized = req => {
    const candidate = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  };
  const publish = () => {
    timer = undefined;
    if (closing || !clients.size) return;
    const frame = `data: ${JSON.stringify(bridge.current())}\n\n`;
    for (const res of clients) {
      // Full snapshots make reconnect safe; don't accumulate unbounded slow-client buffers.
      if (res.writableLength > 8 * 1024 * 1024) { clients.delete(res); res.destroy(); }
      else res.write(frame);
    }
  };
  const unsubscribe = bridge.subscribe(() => { timer ??= setTimeout(publish, 40); });
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      if (res.writableLength > 8 * 1024 * 1024) { clients.delete(res); res.destroy(); }
      else res.write(': keepalive\n\n');
    }
  }, 15000);
  heartbeat.unref();

  async function execute(command) {
    return bridge.execute(command);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (closing) throw error(503, 'Server is closing.');
      if (req.headers.host !== new URL(origin).host) throw error(403, 'Invalid host.');
      if (req.headers.origin && req.headers.origin !== origin) throw error(403, 'Cross-origin requests are not allowed.');
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req)) throw error(401, 'Open the full launch URL printed in the terminal.');
        const localPath = value => {
          if (typeof value !== 'string' || !value || value.includes('\0')) throw error(400, 'Invalid file path.');
          if (value.startsWith('file:')) {
            const file = new URL(value);
            if (file.hostname && file.hostname !== 'localhost') throw error(400, 'Invalid file host.');
            value = decodeURIComponent(file.pathname);
          }
          value = value.replace(/:\d+(?::\d+)?$/, '');
          if (value.startsWith('~/')) value = resolve(homedir(), value.slice(2));
          return resolve(url.searchParams.get('cwd') || bridge.current().session.cwd, value);
        };
        if (req.method === 'POST' && url.pathname === '/api/files/exists') {
          const input = await body(req);
          if (!Array.isArray(input?.paths) || input.paths.length > 256) throw error(400, 'Expected up to 256 paths.');
          const exists = await Promise.all(input.paths.map(async value => {
            try { return (await stat(localPath(value))).isFile(); } catch { return false; }
          }));
          json(res, 200, { exists }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/file') {
          const requested = url.searchParams.get('path');
          let path, bytes, type = '';
          if (/^https?:\/\//i.test(requested || '')) {
            let remote;
            try { remote = await fetch(requested, { signal: AbortSignal.timeout(15000) }); }
            catch { throw error(502, 'Could not fetch the external file.'); }
            if (!remote.ok) { await remote.body?.cancel(); throw error(502, `External server returned ${remote.status}.`); }
            path = remote.url; type = remote.headers.get('content-type') || '';
            const chunks = []; let size = 0;
            for await (const chunk of remote.body) {
              size += chunk.length;
              if (size > 2 * 1024 * 1024) throw error(413, 'Preview is limited to files up to 2 MiB.');
              chunks.push(chunk);
            }
            bytes = Buffer.concat(chunks);
          } else {
            const candidate = localPath(requested);
            let info;
            try { path = await realpath(candidate); info = await stat(path); }
            catch { throw error(404, 'File not found or unavailable.'); }
            if (!info.isFile()) throw error(400, 'This path is not a file.');
            if (info.size > 2 * 1024 * 1024) throw error(413, 'Preview is limited to files up to 2 MiB.');
            try { bytes = await readFile(path); } catch { throw error(403, 'This file cannot be read.'); }
          }
          if (bytes.includes(0)) throw error(415, 'Binary files cannot be displayed as text.');
          json(res, 200, { path, type, content: bytes.toString('utf8') }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          json(res, 200, await bridge.listSessions()); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          json(res, 200, bridge.current()); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify(bridge.current())}\n\n`);
          clients.add(res);
          res.on('close', () => clients.delete(res));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/command') {
          const command = await body(req);
          if (!command || typeof command !== 'object' || Array.isArray(command) || !/^[\w-]{8,80}$/.test(command.requestId || '')) throw error(400, 'Invalid command identifier.');
          const signature = JSON.stringify(command);
          let receipt = receipts.get(command.requestId);
          if (receipt && receipt.signature !== signature) throw error(409, 'Command identifier already used.');
          if (!receipt) {
            // Never evict in-flight commands; bounded cache fails closed under overload.
            if (receipts.size >= 512) {
              const oldest = [...receipts].find(([, item]) => item.done);
              if (!oldest) throw error(429, 'Too many commands in flight.');
              receipts.delete(oldest[0]);
            }
            receipt = { signature, done: false };
            const operation = () => execute(command);
            receipt.promise = command.action === 'abort' ? operation() : queue.then(operation);
            if (command.action !== 'abort') queue = receipt.promise.catch(() => {});
            receipt.promise = receipt.promise.then(value => ({ status: 200, value }), e => ({ status: e.status || 500, value: { error: e.message } })).finally(() => { receipt.done = true; });
            receipts.set(command.requestId, receipt);
          }
          const result = await receipt.promise;
          json(res, result.status, result.value);
          return;
        }
        throw error(404, 'Unknown endpoint.');
      }
      const asset = assets.get(url.pathname);
      if (req.method !== 'GET' || !asset) throw error(404, 'Not found.');
      const content = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1] }); res.end(content);
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.message });
      else res.destroy();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (e) { unsubscribe(); clearInterval(heartbeat); clearTimeout(timer); throw e; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, token, url: `${origin}/#token=${token}`,
    async close() {
      if (closePromise) return closePromise;
      closing = true; unsubscribe(); clearTimeout(timer); clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
      closePromise = new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      return closePromise;
    },
  };
}

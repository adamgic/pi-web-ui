import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { userInfo } from 'node:os';
import * as pty from 'node-pty';

const fail = (status, message) => Object.assign(new Error(message), { status });
function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 300) throw fail(400, 'Invalid terminal dimensions.');
}

// Each tab owns a PTY. Stream closure (including reload) closes that shell.
export function createTerminals({ shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || userInfo().shell || '/bin/sh', args = process.platform === 'win32' ? [] : ['-i'], env = process.env } = {}) {
  const sessions = new Map();
  let closed = false, opening = 0;
  function dispose(entry, kill = true) {
    if (!sessions.delete(entry.id)) return;
    clearTimeout(entry.timer);
    entry.dataListener?.dispose(); entry.exitListener?.dispose();
    if (kill && !entry.exited) { try { entry.pty.kill(); } catch { /* Already exited. */ } }
    entry.res?.end();
  }
  function flush(entry) {
    if (!entry.res || entry.blocked) return;
    while (entry.frames.length) {
      const frame = entry.frames.shift(); entry.bytes -= Buffer.byteLength(frame);
      if (!entry.res.write(frame)) {
        entry.blocked = true; entry.pty.pause();
        entry.res.once('drain', () => {
          entry.blocked = false;
          if (!sessions.has(entry.id)) return;
          flush(entry);
          if (!entry.blocked && !entry.exited) entry.pty.resume();
        });
        return;
      }
    }
    if (entry.exited) dispose(entry, false);
  }
  function send(entry, event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    entry.frames.push(frame); entry.bytes += Buffer.byteLength(frame);
    if (entry.bytes > 1024 * 1024) { dispose(entry); return; }
    flush(entry);
  }
  return {
    async open({ cwd, cols = 80, rows = 24 }) {
      if (closed) throw fail(503, 'Terminal service is closed.');
      if (sessions.size + opening >= 8) throw fail(429, 'Close an existing terminal before opening another.');
      dimensions(cols, rows);
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw fail(400, 'Invalid working directory.');
      opening++;
      try {
        let info;
        try { info = await stat(cwd); } catch { throw fail(404, 'Working directory is unavailable.'); }
        if (!info.isDirectory()) throw fail(400, 'Working directory is not a directory.');
        if (closed) throw fail(503, 'Terminal service is closed.');
        let child;
        try { child = pty.spawn(shell, args, { name: 'xterm-256color', cwd, cols, rows, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } }); }
        catch { throw fail(503, 'Could not start the shell. Check the configured shell and terminal dependencies.'); }
        const entry = { id: randomBytes(24).toString('hex'), pty: child, frames: [], bytes: 0, res: undefined, blocked: false, exited: false };
        sessions.set(entry.id, entry);
        // A tab that never attaches must not leave an orphan shell running.
        entry.timer = setTimeout(() => dispose(entry), 15000); entry.timer.unref();
        entry.dataListener = child.onData(data => send(entry, { type: 'data', data }));
        entry.exitListener = child.onExit(({ exitCode }) => { entry.exited = true; send(entry, { type: 'exit', exitCode }); });
        return { id: entry.id, cwd, shell };
      } finally { opening--; }
    },
    attach(id, res) {
      const entry = sessions.get(id);
      if (!entry) throw fail(404, 'Terminal is closed. Open a new terminal.');
      if (entry.res) throw fail(409, 'Terminal already has a connected tab.');
      clearTimeout(entry.timer); entry.res = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      res.on('close', () => dispose(entry));
      flush(entry);
    },
    command(id, input) {
      const entry = sessions.get(id);
      if (!entry || entry.exited) throw fail(404, 'Terminal is closed. Open a new terminal.');
      if (input.action === 'input') {
        if (typeof input.data !== 'string' || Buffer.byteLength(input.data) > 65536) throw fail(400, 'Terminal input exceeds 64 KiB.');
        entry.pty.write(input.data);
      } else if (input.action === 'resize') {
        dimensions(input.cols, input.rows); entry.pty.resize(input.cols, input.rows);
      } else throw fail(400, 'Unknown terminal action.');
    },
    remove(id) { const entry = sessions.get(id); if (entry) dispose(entry); },
    close() { closed = true; for (const entry of sessions.values()) dispose(entry); },
  };
}

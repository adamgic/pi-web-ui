import { randomBytes } from 'node:crypto';
import { dirname, basename, resolve, relative, extname, isAbsolute } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { mediaType, serveMedia } from './media.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
export function htmlPreviews() {
  const entries = new Map();
  return {
    add(path, content) {
      const id = randomBytes(24).toString('hex');
      const remote = /^https?:/i.test(path);
      const name = remote ? 'document.html' : basename(path);
      if (remote) {
        const base = `<base href="${path.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}">`;
        content = /<head\b[^>]*>/i.test(content) ? content.replace(/<head\b[^>]*>/i, match => match + base) : base + content;
      }
      if (entries.size >= 128) entries.delete(entries.keys().next().value);
      entries.set(id, { root: remote ? null : dirname(path), name, content });
      return `/html/${id}/${encodeURIComponent(name)}`;
    },
    async serve(req, res, url) {
      const [, , id, ...segments] = url.pathname.split('/');
      const entry = entries.get(id);
      if (!entry || req.method !== 'GET') throw fail(404, 'HTML preview not found. Reopen the file.');
      let name;
      try { name = segments.map(decodeURIComponent).join('/'); } catch { throw fail(400, 'Invalid resource path.'); }
      let content, type = 'text/html; charset=utf-8';
      if (name === entry.name) content = entry.content;
      else {
        if (!entry.root) throw fail(404, 'Resource not found.');
        let path;
        try { path = await realpath(resolve(entry.root, name)); } catch { throw fail(404, 'Resource not found.'); }
        const rel = relative(entry.root, path);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw fail(403, 'Resource is outside the HTML directory.');
        const media = mediaType(path);
        if (media) { await serveMedia(req, res, { path, type: media }); return; }
        const info = await stat(path);
        if (!info.isFile() || info.size > 2 * 1024 * 1024) throw fail(413, 'Resource is not a file or exceeds 2 MiB.');
        type = ({ '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' })[extname(path).toLowerCase()] || 'application/octet-stream';
        content = await readFile(path);
      }
      // Opaque-origin sandbox: HTML can render and run its own scripts, but cannot
      // inspect the parent app or read its token/storage. No top navigation/popups.
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' https: http: data: blob:; script-src 'self' https: http: 'unsafe-inline'; style-src 'self' https: http: 'unsafe-inline'; frame-ancestors 'self'; object-src 'none'");
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200, { 'Content-Type': type }); res.end(content);
    },
    clear() { entries.clear(); },
  };
}

import { extname } from 'node:path';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const types = {
  '.png': 'image/png', '.apng': 'image/apng', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
};
export const mediaType = path => types[extname(path).toLowerCase()];

// A scoped URL lets the browser navigate and seek without exposing the API token.
export async function serveMedia(req, res, { path, type }) {
  let file;
  try { file = await open(path, 'r'); }
  catch { throw Object.assign(new Error('Media file not found or unavailable.'), { status: 404 }); }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw Object.assign(new Error('This path is not a file.'), { status: 400 });
    const size = info.size;
    let start = 0, end = size - 1, status = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Accept-Ranges', 'bytes');
    // Keep native video subrequests same-origin, while denying scripts (including
    // scripts embedded in SVG) and other active content.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox allow-same-origin");
    if (req.headers.range && req.method !== 'HEAD') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
        else { start = Math.max(0, size - Number(match[2])); }
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || (match[1] === '' && Number(match[2]) === 0)) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }); res.end(); return;
      }
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', Math.max(0, end - start + 1));
    res.writeHead(status);
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
  } finally { await file.close(); }
}

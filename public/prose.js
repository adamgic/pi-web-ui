import { equation } from './math.js';

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
// Markdown is rendered using DOM text nodes only; model/tool HTML is never executed.
export function linkTarget(value, { token = '', cwd = '' } = {}) {
  if (/^https?:\/\//i.test(cwd) && !/^[a-z][a-z0-9+.-]*:/i.test(value)) value = new URL(value, cwd).href;
  if (/^https?:\/\//i.test(value)) {
    // Web pages retain their native viewer; text/Markdown files use our preview.
    if (!/\.(?:md|markdown|txt|json|csv|log|ya?ml|xml|js|ts|py|css)$/i.test(new URL(value).pathname)) return value;
  }
  if (value.startsWith('#')) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/:\d+(?::\d+)?$/, '')) && !/^(?:file:|https?:)/i.test(value)) return null;
  if (value.startsWith('//')) return null;
  if (value.startsWith('file:')) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost') return null; value = decodeURIComponent(url.pathname); }
    catch { return null; }
  }
  const params = new URLSearchParams({ path: value, cwd });
  return `/preview.html?${params}#token=${encodeURIComponent(token)}`;
}
function inline(parent, text, options) {
  const pattern = /(`[^`]+`|\\\$|\$\$[^$]+\$\$|\$(?!\s)(?:\\.|[^$\\])+?\$|\\\([\s\S]+?\\\)|\*\*[^*]+\*\*|\[[^\]]+\]\((?:<[^>]+>|[^)]+)\)|https?:\/\/[^\s<>]+|(?:\.?\.?\/)?(?:[\w@~.-]+\/)*[\w@.-]+\.[a-zA-Z][a-zA-Z0-9]{0,9}(?::\d+(?::\d+)?)?)/g;
  const appendLink = (label, target, code = false) => {
    const href = linkTarget(target, options);
    const content = code ? el('code', label) : document.createTextNode(label);
    if (!href) { parent.append(content); return; }
    const a = el('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.append(content); parent.append(a);
    if (href.startsWith('/preview.html') && !/^https?:/i.test(new URL(href, location.origin).searchParams.get('path')) && options?.checkFiles !== false) {
      a.dataset.fileCandidate = href;
      a.removeAttribute('href');
    }
  };
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(end, match.index)));
    const part = match[0];
    if (part === '\\$') parent.append(document.createTextNode('$'));
    else if (part.startsWith('$$')) parent.append(equation(part.slice(2, -2), true));
    else if (part.startsWith('$')) parent.append(equation(part.slice(1, -1)));
    else if (part.startsWith('\\(')) parent.append(equation(part.slice(2, -2)));
    else if (part.startsWith('`')) {
      const value = part.slice(1, -1);
      appendLink(value, value, true);
    } else if (part.startsWith('**')) { const strong = el('strong'); inline(strong, part.slice(2, -2), options); parent.append(strong); }
    else if (part.startsWith('[')) {
      const split = part.indexOf('](');
      appendLink(part.slice(1, split), part.slice(split + 2, -1).replace(/^<|>$/g, ''));
    } else {
      const value = part.replace(/[.,;!]+$/, '');
      appendLink(value, value); parent.append(document.createTextNode(part.slice(value.length)));
    }
    end = match.index + part.length;
  }
  parent.append(document.createTextNode(text.slice(end)));
}
export function prose(text, options = {}) {
  const node = el('div', undefined, 'prose');
  let code, paragraph, list, math, mathEnd;
  for (const line of String(text || '').split('\n')) {
    if (!code && math) {
      const end = line.indexOf(mathEnd);
      if (end < 0) math.push(line);
      else {
        math.push(line.slice(0, end)); node.append(equation(math.join('\n'), true));
        math = undefined;
        if (line.slice(end + mathEnd.length).trim()) { const p = el('p'); inline(p, line.slice(end + mathEnd.length), options); node.append(p); }
      }
      continue;
    }
    if (!code && /^(?:\$\$|\\\[)\s*$/.test(line.trim())) {
      math = []; mathEnd = line.trim() === '$$' ? '$$' : '\\]';
      paragraph = undefined; list = undefined; continue;
    }
    if (/^\s*```/.test(line)) {
      if (code) code = undefined;
      else { code = el('pre'); node.append(code); }
      paragraph = undefined; list = undefined; continue;
    }
    if (code) { code.append(document.createTextNode(`${line}\n`)); continue; }
    const item = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      const tag = item[1] ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) { list = el(tag); node.append(list); }
      const li = el('li'); inline(li, item[2], options); list.append(li); paragraph = undefined; continue;
    }
    list = undefined;
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { const h = el(`h${Math.min(4, heading[1].length + 1)}`); inline(h, heading[2], options); node.append(h); paragraph = undefined; }
    else if (!line) paragraph = undefined;
    else {
      if (!paragraph) { paragraph = el('p'); node.append(paragraph); }
      else paragraph.append(document.createTextNode('\n'));
      inline(paragraph, line, options);
    }
  }
  if (math) node.append(el('pre', `${mathEnd === '$$' ? '$$' : '\\['}\n${math.join('\n')}`));
  const candidates = [...node.querySelectorAll('[data-file-candidate]')];
  if (candidates.length) void verifyFiles(candidates, options);
  return node;
}

async function verifyFiles(candidates, { token = '' } = {}) {
  for (let offset = 0; offset < candidates.length; offset += 256) {
    const group = candidates.slice(offset, offset + 256);
    const urls = group.map(a => new URL(a.dataset.fileCandidate, location.origin));
    try {
      const response = await fetch(`/api/files/exists?${new URLSearchParams({ cwd: urls[0].searchParams.get('cwd') || '' })}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: urls.map(url => url.searchParams.get('path')) }),
      });
      if (!response.ok) throw new Error('File check failed');
      const { exists } = await response.json();
      group.forEach((a, index) => { if (exists[index]) a.href = a.dataset.fileCandidate; else a.replaceWith(...a.childNodes); delete a.dataset.fileCandidate; });
    } catch { group.forEach(a => a.replaceWith(...a.childNodes)); }
  }
}

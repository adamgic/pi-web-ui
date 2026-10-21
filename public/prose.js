function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
// Markdown is rendered using DOM text nodes only; model/tool HTML is never executed.
export function linkTarget(value, { token = '', cwd = '' } = {}) {
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('#')) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/:\d+(?::\d+)?$/, '')) && !value.startsWith('file:')) return null;
  if (value.startsWith('//')) return null;
  if (value.startsWith('file:')) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost') return null; value = decodeURIComponent(url.pathname); }
    catch { return null; }
  }
  const params = new URLSearchParams({ path: value, cwd });
  return `/preview.html?${params}#token=${encodeURIComponent(token)}`;
}
function inline(parent, text, options) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((?:<[^>]+>|[^)]+)\)|https?:\/\/[^\s<>]+|(?:\.?\.?\/)?(?:[\w@~.-]+\/)*[\w@.-]+\.[a-zA-Z][a-zA-Z0-9]{0,9}(?::\d+(?::\d+)?)?)/g;
  const appendLink = (label, target, code = false) => {
    const href = linkTarget(target, options);
    const content = code ? el('code', label) : document.createTextNode(label);
    if (!href) { parent.append(content); return; }
    const a = el('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.append(content); parent.append(a);
  };
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(end, match.index)));
    const part = match[0];
    if (part.startsWith('`')) {
      const value = part.slice(1, -1);
      if (/^(?:https?:\/\/|file:|\/|\.\.?\/)/.test(value) || /^[\w@./ -]+\.[a-zA-Z0-9]+(?::\d+(?::\d+)?)?$/.test(value)) appendLink(value, value, true);
      else parent.append(el('code', value));
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
  let code, paragraph, list;
  for (const line of String(text || '').split('\n')) {
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
  return node;
}

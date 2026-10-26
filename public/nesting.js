// Structural coloring, not a compiler: preserve every source character and
// ignore delimiters inside strings/comments. JSON uses alternating key/value levels.
export const palettes = {
  light: ['#1756a9', '#a04400', '#087344', '#aa2464', '#7141a6'],
  dark: ['#80baff', '#ffb366', '#70d6a0', '#ff91bd', '#c4a0ff'],
};
export const colorNames = ['Blue', 'Orange', 'Green', 'Pink', 'Purple'];

function collector() {
  const parts = [];
  return {
    parts,
    add(text, depth) {
      if (!text) return;
      depth = Math.max(0, depth);
      const last = parts.at(-1);
      if (last?.depth === depth) last.text += text;
      else parts.push({ text, depth });
    },
  };
}

export function jsonNesting(source) {
  const out = collector(), stack = [];
  const tokens = source.match(/"(?:\\.|[^"\\])*"?|\s+|[{}\[\]:,]|[^\s{}\[\]:,"]+/g) || [];
  for (const text of tokens) {
    const parent = stack.at(-1);
    const valueDepth = parent ? parent.kind === '{' ? parent.level + 1 : parent.level : 0;
    const depth = parent?.key ? parent.level : valueDepth;
    if (/^\s+$/.test(text)) { out.add(text, depth); continue; }
    if (text === '{' || text === '[') {
      out.add(text, valueDepth);
      stack.push({ kind: text, color: valueDepth, level: stack.length ? valueDepth + 1 : text === '{' ? 0 : 1, key: text === '{' });
    } else if (text === '}' || text === ']') {
      out.add(text, stack.pop()?.color ?? 0);
    } else if (text === ':') {
      out.add(text, parent?.level ?? 0);
      if (parent) parent.key = false;
    } else if (text === ',') {
      out.add(text, parent?.color ?? 0);
      if (parent?.kind === '{') parent.key = true;
    } else out.add(text, depth);
  }
  return out.parts;
}

export function nestingParts(source, language = '') {
  if (language === 'json') return jsonNesting(source);
  if (language === 'xml') return markupNesting(source);
  const out = collector();
  const indented = ['python', 'yaml'].includes(language);
  const hashComments = ['python', 'yaml', 'bash', 'ruby', 'perl', 'r', 'ini'].includes(language);
  const brackets = [], indents = [0];
  let index = 0, lineStart = true, base = 0, continued = false;
  let previous = ''; // Used to recognize JS regex literals after operators.
  while (index < source.length) {
    if (lineStart) {
      const whitespace = /^[ \t]*/.exec(source.slice(index))[0];
      const next = source[index + whitespace.length];
      if (indented && !brackets.length && !continued && next && next !== '\n' && next !== '\r' && next !== '#') {
        let width = 0;
        for (const c of whitespace) width = c === '\t' ? width + 8 - width % 8 : width + 1;
        while (indents.length > 1 && width < indents.at(-1)) indents.pop();
        if (width > indents.at(-1)) indents.push(width);
        base = indents.length - 1;
      }
      out.add(whitespace, base + brackets.length); index += whitespace.length;
      lineStart = false; continued = false;
      if (index >= source.length) break;
    }
    const c = source[index], rest = source.slice(index), depth = base + brackets.length;
    if (c === '\n') { out.add(c, depth); index++; lineStart = true; continue; }
    if ((hashComments && c === '#') || (!hashComments && rest.startsWith('//')) || (language === 'sql' && rest.startsWith('--'))) {
      const end = source.indexOf('\n', index);
      const stop = end < 0 ? source.length : end;
      out.add(source.slice(index, stop), depth); index = stop; continue;
    }
    if (!hashComments && rest.startsWith('/*')) {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      out.add(source.slice(index, stop), depth); index = stop; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      // Python triple-quoted strings and JS templates remain one lexical region.
      const quote = language === 'python' && rest.startsWith(c.repeat(3)) ? c.repeat(3) : c;
      let end = index + quote.length;
      while (end < source.length) {
        if (source[end] === '\\') { end += 2; continue; }
        if (source.startsWith(quote, end)) { end += quote.length; break; }
        end++;
      }
      out.add(source.slice(index, end), depth); index = end; previous = 'value'; continue;
    }
    if (['javascript', 'typescript'].includes(language) && c === '/' && /^(?:|[=(:,!&|?;{}]|return|yield)$/.test(previous)) {
      let end = index + 1, inClass = false;
      while (end < source.length && source[end] !== '\n') {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === '[') inClass = true;
        if (source[end] === ']') inClass = false;
        if (source[end++] === '/' && !inClass) { while (/[a-z]/i.test(source[end] || '') && end < source.length) end++; break; }
      }
      out.add(source.slice(index, end), depth); index = end; previous = 'value'; continue;
    }
    if ('([{'.includes(c)) { out.add(c, depth); brackets.push(c); previous = c; index++; continue; }
    if (')]}'.includes(c)) {
      const open = '([{'[')]}'.indexOf(c)];
      if (brackets.at(-1) === open) brackets.pop();
      out.add(c, base + brackets.length); previous = c; index++; continue;
    }
    if (c === '\\' && /^\\\r?\n/.test(rest)) continued = true;
    const word = /^[\w]+/.exec(rest)?.[0];
    const chunk = word || c;
    out.add(chunk, depth); index += chunk.length;
    if (!/^\s+$/.test(chunk)) previous = chunk;
  }
  return out.parts;
}

function markupNesting(source) {
  const out = collector(), stack = [];
  const voids = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
  const pattern = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/?[a-zA-Z][\w:.-]*(?:"[^"]*"|'[^']*'|[^'">])*?>/g;
  let end = 0;
  for (const match of source.matchAll(pattern)) {
    const tag = match[0], name = /^<\/?([\w:.-]+)/.exec(tag)?.[1].toLowerCase();
    if (['script', 'style'].includes(stack.at(-1)) && !(tag.startsWith('</') && name === stack.at(-1))) continue;
    out.add(source.slice(end, match.index), stack.length);
    if (name && tag.startsWith('</')) {
      const position = stack.lastIndexOf(name); if (position >= 0) stack.length = position;
    }
    out.add(tag, stack.length);
    if (name && !tag.startsWith('</') && !tag.endsWith('/>') && !voids.has(name)) stack.push(name);
    end = match.index + tag.length;
  }
  out.add(source.slice(end), stack.length);
  return out.parts;
}

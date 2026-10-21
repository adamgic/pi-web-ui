import hljs from './vendor/highlight/highlight.js';
import { nestingParts, colorNames } from './nesting.js';

const extensions = {
  py: 'python', pyw: 'python', json: 'json', jsonl: 'json', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  java: 'java', go: 'go', rs: 'rust', css: 'css', scss: 'scss', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash', rb: 'ruby', php: 'php', sql: 'sql',
  md: 'markdown', markdown: 'markdown', toml: 'ini', ini: 'ini', kt: 'kotlin', swift: 'swift', r: 'r', pl: 'perl', lua: 'lua',
};
export function languageFor(path) {
  const name = path.split('/').at(-1).toLowerCase();
  return extensions[name.split('.').at(-1)] || (name === 'makefile' ? 'makefile' : 'plaintext');
}
export function savedHighlightMode() {
  try { return localStorage.getItem('pi-highlight-mode') === 'standard' ? 'standard' : 'nesting'; }
  catch { return 'nesting'; }
}
export function saveHighlightMode(mode) {
  try { localStorage.setItem('pi-highlight-mode', mode); } catch { /* Storage may be disabled. */ }
}
export function highlightedCode(source, language, mode) {
  const pre = document.createElement('pre');
  pre.className = `source-code highlight-${mode}`;
  const code = document.createElement('code');
  pre.append(code);
  if (mode === 'standard' && hljs.getLanguage(language)) {
    // Only Highlight.js-generated escaped markup is inserted, never file HTML.
    code.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
    code.className = 'hljs';
  } else if (mode === 'nesting' && language !== 'plaintext') {
    for (const part of nestingParts(source, language)) {
      const span = document.createElement('span');
      const color = part.depth % colorNames.length;
      span.className = `nest-color-${color}`;
      span.dataset.depth = String(part.depth);
      span.title = `Level ${part.depth} · ${colorNames[color]}`;
      span.textContent = part.text;
      code.append(span);
    }
  } else code.textContent = source;
  return pre;
}
export { colorNames };

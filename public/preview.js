import { highlightedCode, languageFor, savedHighlightMode, saveHighlightMode, colorNames } from './highlighting.js';
import { prose } from './prose.js';
const params = new URLSearchParams(location.search);
const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('pi-web-token');
if (token) sessionStorage.setItem('pi-web-token', token);
history.replaceState(null, '', location.pathname + location.search);
const content = document.getElementById('content');
try {
  const response = await fetch(`/api/file?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const file = await response.json();
  if (!response.ok) throw new Error(file.error);
  document.getElementById('filename').textContent = file.path;
  document.title = `${file.path.split('/').pop()} · Pi`;
  const remote = /^https?:/i.test(file.path);
  const pathname = remote ? new URL(file.path).pathname : file.path;
  let source = !/\.(md|markdown)$/i.test(pathname) && !file.type?.includes('text/markdown');
  const language = languageFor(pathname);
  const mode = document.getElementById('highlight-mode');
  mode.value = savedHighlightMode();
  const legend = document.getElementById('color-legend');
  colorNames.forEach((name, index) => {
    const chip = document.createElement('span'); chip.className = `nest-color-${index}`;
    chip.textContent = `${index} ${name}`; legend.append(chip);
  });
  const render = () => {
    document.getElementById('highlight-controls').hidden = !source;
    legend.hidden = mode.value !== 'nesting' || language === 'plaintext';
    document.getElementById('highlight-note').textContent = mode.value === 'standard'
      ? 'Standard syntax · Highlight.js'
      : language === 'json' ? 'Keys → values → nested keys → nested values. Colors repeat every five levels.'
      : ['python', 'yaml'].includes(language) ? 'Indentation and bracket nesting. Colors repeat every five levels.'
      : language === 'plaintext' ? 'Plain text: no language detected.'
      : 'Bracket nesting; strings and comments stay at their surrounding level. Colors repeat every five levels.';
    if (source) content.replaceChildren(highlightedCode(file.content, language, mode.value));
    else content.replaceChildren(prose(file.content, { token, cwd: remote ? file.path : file.path.slice(0, file.path.lastIndexOf('/')) }));
  };
  mode.onchange = () => { saveHighlightMode(mode.value); render(); };
  const toggle = document.getElementById('toggle');
  toggle.hidden = source;
  toggle.onclick = () => { source = !source; toggle.textContent = source ? 'View preview' : 'View source'; render(); };
  render();
} catch (error) { content.textContent = error.message; }

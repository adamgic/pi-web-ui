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
  let source = !/\.(md|markdown)$/i.test(file.path);
  const render = () => {
    if (source) { const pre = document.createElement('pre'); pre.textContent = file.content; content.replaceChildren(pre); }
    else content.replaceChildren(prose(file.content, { token, cwd: file.path.slice(0, file.path.lastIndexOf('/')) }));
  };
  const toggle = document.getElementById('toggle');
  toggle.hidden = source;
  toggle.onclick = () => { source = !source; toggle.textContent = source ? 'View preview' : 'View source'; render(); };
  render();
} catch (error) { content.textContent = error.message; }

// Markdown diagrams are rendered outside the authenticated preview document.
export function renderDiagrams(root) {
  const theme = matchMedia('(prefers-color-scheme: dark)');
  const entries = [];
  for (const block of root.querySelectorAll('[data-diagram="mermaid"]')) {
    const source = block.querySelector('pre').textContent;
    const wrapper = document.createElement('section'); wrapper.className = 'diagram-block';
    const status = document.createElement('p'); status.className = 'muted diagram-status'; status.textContent = 'Rendering diagram…'; status.setAttribute('role', 'status');
    const details = document.createElement('details'); details.className = 'diagram-source'; details.open = true;
    const summary = document.createElement('summary'); summary.textContent = 'Diagram source';
    const frame = document.createElement('iframe'); frame.className = 'diagram-preview'; frame.title = 'Mermaid diagram';
    frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
    block.replaceWith(wrapper); details.append(summary, block); wrapper.append(status, frame, details);
    const entry = { id: crypto.randomUUID(), frame, source, details, status, wrapper, ready: false, loaded: false };
    entries.push(entry);
    if (source.length > 50_000) { status.textContent = 'Diagram is too large to render. Source is shown below.'; frame.remove(); continue; }
    frame.onload = () => { entry.loaded = true; render(entry); };
    frame.src = '/diagram.html';
  }
  function render(entry) {
    if (!entry.loaded) return;
    entry.frame.contentWindow.postMessage({ type: 'pi-diagram-render', id: entry.id, source: entry.source, dark: theme.matches }, '*');
  }
  const onMessage = event => {
    const entry = entries.find(entry => event.source === entry.frame.contentWindow && event.data?.id === entry.id);
    if (!entry) return;
    if (event.data.type === 'pi-diagram-ready') {
      entry.wrapper.dataset.rendered = 'true'; entry.status.hidden = true;
      if (!entry.ready) entry.details.open = false;
      entry.ready = true; entry.frame.hidden = false;
    } else if (event.data.type === 'pi-diagram-error') {
      entry.wrapper.dataset.rendered = 'error'; entry.frame.hidden = true; entry.status.hidden = false;
      entry.status.textContent = 'Unable to render this Mermaid diagram. Check the source below.'; entry.details.open = true;
    } else if (event.data.type === 'pi-diagram-size' && Number.isFinite(event.data.height)) {
      entry.frame.style.height = `${Math.max(80, Math.min(2400, event.data.height))}px`;
    }
  };
  const onTheme = () => entries.forEach(render);
  window.addEventListener('message', onMessage); theme.addEventListener('change', onTheme);
  return () => { window.removeEventListener('message', onMessage); theme.removeEventListener('change', onTheme); entries.forEach(({ frame }) => { frame.onload = null; }); };
}

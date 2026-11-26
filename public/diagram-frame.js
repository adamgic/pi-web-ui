// This document has an opaque sandbox origin and receives no authentication.
const diagram = document.getElementById('diagram');
let serial = 0, currentId, queue = Promise.resolve();
const reportSize = () => {
  if (currentId) parent.postMessage({ type: 'pi-diagram-size', id: currentId, height: Math.ceil(diagram.getBoundingClientRect().height + 24) }, '*');
};
new ResizeObserver(reportSize).observe(diagram);
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'pi-diagram-render' || typeof event.data.source !== 'string' || typeof event.data.id !== 'string') return;
  const { id, source, dark } = event.data;
  const version = ++serial;
  queue = queue.then(async () => {
    if (version !== serial) return;
    currentId = undefined; diagram.replaceChildren();
    try {
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default',
        suppressErrorRendering: true, maxTextSize: 50_000, maxEdges: 500,
        htmlLabels: false, flowchart: { htmlLabels: false },
        secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart'],
      });
      const result = await mermaid.render(`diagram-${version}`, source);
      if (version !== serial) return;
      // Mermaid sanitizes the SVG; the iframe adds origin and network isolation.
      diagram.innerHTML = result.svg;
      currentId = id;
      parent.postMessage({ type: 'pi-diagram-ready', id }, '*'); reportSize();
    } catch {
      diagram.replaceChildren();
      parent.postMessage({ type: 'pi-diagram-error', id }, '*');
    }
  });
});

import katex from './vendor/katex/katex.mjs';

// Native MathML works with our strict CSP and provides accessible mathematics
// without remote fonts, inline styles, or executing any document HTML.
export function equation(tex, displayMode = false) {
  const node = document.createElement(displayMode ? 'div' : 'span');
  node.className = displayMode ? 'equation equation-display' : 'equation';
  try {
    katex.render(tex, node, {
      displayMode, output: 'mathml', trust: false, throwOnError: true,
      maxExpand: 1000, maxSize: 20, strict: 'ignore',
    });
  } catch {
    node.classList.add('equation-error');
    node.textContent = displayMode ? `$$\n${tex}\n$$` : `$${tex}$`;
    node.title = 'This equation could not be rendered; showing its source.';
  }
  return node;
}

export async function copyValue(label, value) {
  try { await navigator.clipboard.writeText(String(value)); showToast(`${label} copied`); }
  catch { showToast('Copy unavailable. Select the value to copy manually.'); }
}

// Shared by the conversation and standalone previews. Notices expire in order.
function showToast(message) {
  let container = document.getElementById('toasts');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toasts'; container.className = 'toasts';
    container.setAttribute('role', 'status'); container.setAttribute('aria-live', 'polite');
    document.body.append(container);
  }
  const toast = document.createElement('div'); toast.className = 'toast entering';
  const content = document.createElement('div'); content.className = 'toast-content';
  const text = document.createElement('div'); text.className = 'toast-message'; text.textContent = message;
  content.append(text); toast.append(content); container.append(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.remove('entering')));
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 180);
  }, 3000);
}

export function copyButton(label, source, className = 'copy-content', toastLabel = label) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className;
  button.setAttribute('aria-label', `Copy ${label}`); button.title = `Copy ${label}`;
  const icon = document.createElement('span'); icon.className = 'copy-icon';
  icon.setAttribute('aria-hidden', 'true'); button.append(icon);
  button.onclick = event => {
    event.preventDefault(); event.stopPropagation();
    void copyValue(toastLabel, typeof source === 'function' ? source() : source);
  };
  return button;
}

export function copyableCode(pre, source = () => pre.textContent) {
  const block = document.createElement('div'); block.className = 'code-block';
  const button = copyButton('code', source, 'copy-code', 'Code');
  // Keep controls outside <pre>, so selecting or copying code never includes UI text.
  block.append(pre, button);
  return block;
}

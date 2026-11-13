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

export function copyableCode(pre, source = () => pre.textContent) {
  const block = document.createElement('div'); block.className = 'code-block';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'copy-code';
  button.setAttribute('aria-label', 'Copy code'); button.title = 'Copy code';
  const icon = document.createElement('span'); icon.className = 'copy-icon';
  icon.setAttribute('aria-hidden', 'true'); button.append(icon);
  // Keep controls outside <pre>, so selecting or copying code never includes UI text.
  button.onclick = () => copyValue('Code', typeof source === 'function' ? source() : source);
  block.append(pre, button);
  return block;
}

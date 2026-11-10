import { previewLink } from './preview-links.js';

// Browsing is independent of the active conversation and never changes Pi's cwd.
export function createExplorer({ token, copyPath }) {
  const $ = id => document.getElementById(id);
  const toggle = $('explorer-toggle');
  const panel = $('file-explorer');
  const list = $('explorer-entries');
  const status = $('explorer-status');
  let cwd, current, request = 0, loading = false;
  const pathInfo = document.createElement('div');
  pathInfo.id = 'explorer-path-info'; pathInfo.className = 'explorer-path-info';
  pathInfo.hidden = true; pathInfo.setAttribute('role', 'button'); pathInfo.tabIndex = 0;
  pathInfo.setAttribute('aria-label', 'Copy full path');
  const infoText = document.createElement('span'); infoText.id = 'explorer-path-info-text';
  const infoNote = document.createElement('small');
  pathInfo.append(infoText, infoNote); document.body.append(pathInfo);
  let activePath, openTimer, closeTimer;

  function hidePathInfo() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    activePath?.node.removeAttribute('aria-describedby');
    pathInfo.hidden = true; activePath = undefined;
  }
  function deferHidePathInfo() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (activePath?.node.matches(':hover') || pathInfo.matches(':hover') || activePath?.node === document.activeElement || pathInfo.contains(document.activeElement)) return;
      hidePathInfo();
    }, 220);
  }
  function showPathInfo(node, path, note = '', pointer) {
    hidePathInfo();
    activePath = { node, path };
    infoText.textContent = path; infoNote.textContent = note; infoNote.hidden = !note;
    node.setAttribute('aria-describedby', infoText.id);
    pathInfo.hidden = false;
    const box = node.getBoundingClientRect();
    const width = pathInfo.offsetWidth, height = pathInfo.offsetHeight;
    const left = pointer ? pointer.x + 10 : box.left;
    // Touch the item's edge so the pointer can enter without crossing another row.
    const below = pointer ? Math.min(pointer.y + 20, box.bottom) : box.bottom;
    const top = below + height <= innerHeight - 8 ? below : box.top - height;
    pathInfo.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
    pathInfo.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
  }
  function pathHover(node, path, note) {
    const schedule = pointer => {
      hidePathInfo();
      openTimer = setTimeout(() => showPathInfo(node, path, note, pointer), 650);
    };
    node.addEventListener('mouseenter', event => schedule({ x: event.clientX, y: event.clientY }));
    node.addEventListener('mouseleave', deferHidePathInfo);
    node.addEventListener('focus', () => schedule());
    node.addEventListener('blur', deferHidePathInfo);
    node.addEventListener('keydown', event => {
      if (event.key === 'Tab' && !event.shiftKey && activePath?.node === node && !pathInfo.hidden) {
        event.preventDefault(); pathInfo.focus();
      }
    });
  }
  pathInfo.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  pathInfo.addEventListener('mouseleave', deferHidePathInfo);
  pathInfo.addEventListener('focusout', deferHidePathInfo);
  pathInfo.onclick = () => { if (activePath) void copyPath(activePath.path); };
  pathInfo.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); pathInfo.click(); return;
    }
    if (event.key !== 'Tab') return;
    const node = activePath?.node;
    if (event.shiftKey) event.preventDefault();
    node?.focus(); hidePathInfo();
  });
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.key !== 'Escape' || pathInfo.hidden) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (pathInfo.contains(document.activeElement)) activePath?.node.focus();
    hidePathInfo();
  });
  document.addEventListener('pointerdown', event => {
    if (!pathInfo.contains(event.target) && event.target !== activePath?.node) hidePathInfo();
  });
  window.addEventListener('resize', hidePathInfo);
  document.addEventListener('scroll', event => {
    if (!pathInfo.contains(event.target)) hidePathInfo();
  }, true);

  function renderBreadcrumbs(path) {
    const container = $('explorer-path');
    const windows = /^[a-z]:\\/i.test(path) || path.startsWith('\\\\');
    const separator = windows ? '\\' : '/';
    const root = windows ? path.match(/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\?)/i)?.[0] || '\\' : '/';
    const parts = path.slice(root.length).split(separator).filter(Boolean);
    const fragment = document.createDocumentFragment();
    const crumb = (label, destination, last) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'explorer-crumb'; button.textContent = label;
      button.setAttribute('aria-label', `Open directory ${destination}`);
      if (last) button.setAttribute('aria-current', 'location');
      button.onclick = () => void navigate(destination);
      pathHover(button, destination);
      fragment.append(button);
    };
    crumb(root, root, !parts.length);
    let destination = root;
    parts.forEach((part, index) => {
      if (!destination.endsWith(separator)) {
        fragment.append(document.createTextNode(separator));
        destination += separator;
      }
      destination += part;
      crumb(part, destination, index === parts.length - 1);
    });
    container.replaceChildren(fragment);
  }

  function controls() {
    toggle.disabled = !cwd;
    $('explorer-up').disabled = loading || !current?.parent;
    $('explorer-home').disabled = !cwd;
    $('explorer-refresh').disabled = loading || !cwd;
    list.setAttribute('aria-busy', String(loading));
  }
  async function navigate(path) {
    hidePathInfo();
    const id = ++request;
    loading = true;
    status.textContent = 'Loading…';
    controls();
    try {
      const response = await fetch(`/api/directory?${new URLSearchParams({ path })}`, { headers: { Authorization: `Bearer ${token}` } });
      const directory = await response.json();
      if (id !== request) return;
      if (!response.ok) throw new Error(directory.error || 'Could not load directory.');
      current = directory;
      hidePathInfo();
      renderBreadcrumbs(directory.path);
      const contents = document.createDocumentFragment();
      for (const entry of directory.entries) {
        const row = document.createElement('li');
        const node = document.createElement(entry.type === 'file' ? 'a' : 'button');
        node.className = `explorer-entry ${entry.type}`;
        node.textContent = entry.name;
        const note = [entry.symlink ? 'Symbolic link' : '', entry.type === 'unavailable' ? 'Unavailable' : entry.type === 'other' ? 'Not a regular file' : ''].filter(Boolean).join(' · ');
        pathHover(node, entry.path, note);
        if (entry.type === 'directory') {
          node.type = 'button';
          node.setAttribute('aria-label', `Open directory ${entry.name}`);
          node.onclick = () => void navigate(entry.path);
        } else if (entry.type === 'file') {
          node.href = previewLink({ path: entry.path, literal: '1' }, token);
          node.target = '_blank'; node.rel = 'noopener noreferrer';
        } else {
          node.type = 'button'; node.setAttribute('aria-disabled', 'true');
        }
        row.append(node); contents.append(row);
      }
      list.replaceChildren(contents);
      list.scrollTop = 0;
      status.textContent = directory.entries.length ? '' : 'This directory is empty.';
    } catch (error) {
      if (id === request) status.textContent = error.message;
    } finally {
      if (id === request) { loading = false; controls(); }
    }
  }
  toggle.onclick = () => {
    hidePathInfo();
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden && !current && !loading) void navigate(cwd);
  };
  $('explorer-up').onclick = () => { if (current?.parent) void navigate(current.parent); };
  $('explorer-home').onclick = () => void navigate(cwd);
  $('explorer-refresh').onclick = () => void navigate(current?.path || cwd);
  controls();
  return {
    setWorkingDirectory(path) {
      if (cwd === path) return;
      cwd = path;
      controls();
      if (!panel.hidden && !current && !loading) void navigate(cwd);
    },
  };
}

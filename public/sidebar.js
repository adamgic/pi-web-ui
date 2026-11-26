// A persistent, keyboard-accessible splitter for the desktop workspace.
export function setupSidebar() {
  const workspace = document.querySelector('.workspace');
  const sidebar = workspace.querySelector('.sidebar');
  const handle = document.getElementById('sidebar-resize');
  const desktop = matchMedia('(min-width: 701px)');
  const storageKey = 'pi-web-sidebar-width';
  let preferred, drag;
  try { const saved = Number(localStorage.getItem(storageKey)); if (saved >= 180 && Number.isFinite(saved)) preferred = saved; } catch { /* Storage may be disabled. */ }
  const bounds = () => ({ min: 180, max: Math.max(180, Math.min(workspace.clientWidth * 0.6, workspace.clientWidth - 360)) });
  const defaultWidth = () => innerWidth <= 1050 || innerHeight <= 560 ? 210 : 260;
  const layout = () => {
    const { min, max } = bounds();
    const width = Math.round(Math.max(min, Math.min(max, preferred ?? defaultWidth())));
    workspace.style.setProperty('--sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(Math.floor(max)));
    handle.setAttribute('aria-valuenow', String(width)); handle.setAttribute('aria-valuetext', `${width} pixels`);
  };
  const save = () => { try { if (preferred === undefined) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, String(preferred)); } catch { /* Resizing still works without storage. */ } };
  const finish = cancelled => {
    if (!drag) return;
    const { pointerId, previous } = drag; drag = undefined;
    if (cancelled) preferred = previous; else save();
    document.body.classList.remove('resizing-sidebar');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    layout();
  };
  handle.onpointerdown = event => {
    if (event.button !== 0 || !desktop.matches) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebar.getBoundingClientRect().width, previous: preferred };
    handle.setPointerCapture(event.pointerId); handle.focus(); document.body.classList.add('resizing-sidebar');
  };
  handle.onpointermove = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { min, max } = bounds();
    preferred = Math.round(Math.max(min, Math.min(max, drag.startWidth + event.clientX - drag.startX))); layout();
  };
  handle.onpointerup = () => finish(false);
  handle.onpointercancel = () => finish(true);
  handle.onlostpointercapture = () => finish(true);
  handle.ondblclick = () => { preferred = undefined; save(); layout(); };
  handle.onkeydown = event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const { min, max } = bounds();
    preferred = event.key === 'Enter' ? undefined : event.key === 'Home' ? min : event.key === 'End' ? Math.floor(max)
      : Math.max(min, Math.min(max, sidebar.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -16 : 16)));
    save(); layout();
  };
  new ResizeObserver(() => { if (!desktop.matches) finish(true); layout(); }).observe(workspace);
  window.addEventListener('resize', layout);
  layout();
}

export function createBranch({ token }) {
  const label = document.getElementById('branch-label');
  const value = document.getElementById('branch-name');
  let cwd, request = 0;
  async function refresh() {
    if (!cwd || document.hidden) return;
    const id = ++request;
    try {
      const response = await fetch('/api/git/branch', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(7000) });
      const branch = await response.json();
      if (id !== request) return;
      if (!response.ok) throw new Error(branch.error);
      if (branch.cwd !== cwd) return;
      value.textContent = branch.name;
    } catch { if (id === request) value.textContent = 'Branch unavailable'; }
  }
  setInterval(refresh, 5000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return {
    setWorkingDirectory(path) {
      if (cwd === path) return;
      cwd = path;
      value.textContent = 'Checking…';
      label.href = `/terminal.html?${new URLSearchParams({ cwd })}#token=${encodeURIComponent(token)}`;
      void refresh();
    },
  };
}

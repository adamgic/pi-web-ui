import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function gitBranch(cwd) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  const git = args => exec('git', ['-C', cwd, ...args], { env, timeout: 3000, maxBuffer: 65536, windowsHide: true });
  try {
    const { stdout } = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { cwd, kind: 'branch', name: stdout.trim() };
  } catch (error) {
    if (error.code === 1) {
      try {
        const { stdout } = await git(['rev-parse', '--short', 'HEAD']);
        return { cwd, kind: 'detached', name: `Detached HEAD (${stdout.trim()})` };
      } catch { /* Report unavailable below. */ }
    }
    if (/not a git repository/i.test(error.stderr || '')) return { cwd, kind: 'none', name: 'Not a Git repository' };
    return { cwd, kind: 'unavailable', name: 'Branch unavailable' };
  }
}

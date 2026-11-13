import { chmod, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Some node-pty tarballs ship the Unix spawn helper without its executable bit.
// Fix only that helper at install time; no compiler is needed for prebuilt targets.
if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const directory of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release', 'build/Debug']) {
    const helper = join(root, directory, 'spawn-helper');
    try { await access(helper); } catch { continue; }
    await chmod(helper, 0o755);
  }
}

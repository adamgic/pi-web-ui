import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const directory of ['src', 'public', 'test', 'scripts']) {
  for (const file of await readdir(new URL(`../${directory}/`, import.meta.url))) {
    if (!/\.(?:mjs|js|ts)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(1);
  }
}
const result = spawnSync(process.execPath, ['--check', 'start.mjs'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(1);
console.log('JavaScript syntax checks passed.');

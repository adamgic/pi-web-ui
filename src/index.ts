import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager, getPackageDir } from '@earendil-works/pi-coding-agent';
import webUI from './extension.js';

export default function (pi: Parameters<typeof webUI>[0]) {
  webUI(pi, {
    listSessions: (cwd: string, directory: string) => SessionManager.list(cwd, directory),
    readChangelog: () => readFile(join(getPackageDir(), 'CHANGELOG.md'), 'utf8'),
  });
}

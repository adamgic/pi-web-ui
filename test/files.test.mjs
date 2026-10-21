import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { linkTarget } from '../public/prose.js';

test('link destinations preserve web URLs and encode local paths safely', () => {
  assert.equal(linkTarget('https://example.com/a?q=b'), 'https://example.com/a?q=b');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//evil.example', 'file://remote/a']) assert.equal(linkTarget(value), null);
  const url = new URL(linkTarget('file:///tmp/My%20Notes.md', { token: 'secret', cwd: '/tmp' }), 'http://localhost');
  assert.equal(url.searchParams.get('path'), '/tmp/My Notes.md');
  assert.equal(url.hash, '#token=secret');
});

test('file previews require authentication and confine reads including symlinks', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-preview-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  const { mkdir } = await import('node:fs/promises'); await mkdir(root);
  await writeFile(join(root, 'My Notes.md'), '# Hello\n<script>alert(1)</script>');
  await writeFile(join(dir, 'outside.txt'), 'private');
  await symlink(join(dir, 'outside.txt'), join(root, 'escape.txt'));
  await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
  const server = await startServer({ subscribe: () => () => {}, current: () => ({ session: { cwd: root } }) });
  t.after(() => server.close());
  const get = (path, auth = true) => fetch(`${server.origin}/api/file?${new URLSearchParams({ path })}`, { headers: auth ? { Authorization: `Bearer ${server.token}` } : {} });
  assert.equal((await get('My Notes.md', false)).status, 401);
  const response = await get('My Notes.md:12:3');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, '# Hello\n<script>alert(1)</script>');
  for (const path of ['../outside.txt', join(dir, 'outside.txt'), 'escape.txt']) assert.equal((await get(path)).status, 403);
  assert.equal((await get('missing')).status, 404);
  assert.equal((await get('binary')).status, 415);
});

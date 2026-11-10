import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { startServer } from '../src/server.mjs';
import { linkTarget } from '../public/prose.js';
import { previewLink, readPreviewFragment } from '../public/preview-links.js';

test('link destinations preserve web URLs and encode local paths safely', () => {
  assert.equal(linkTarget('https://example.com/a?q=b'), 'https://example.com/a?q=b');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//evil.example', 'file://remote/a']) assert.equal(linkTarget(value), null);
  const url = new URL(linkTarget('file:///tmp/My%20Notes.md', { token: 'secret', cwd: '/tmp' }), 'http://localhost');
  assert.equal(url.searchParams.get('path'), '/tmp/My Notes.md');
  assert.equal(url.hash, '#token=secret');
});

test('preview tokens and anchors round trip independently, including legacy double-hash links', () => {
  const anchor = '6-tools-delegation-policies-and-extensibility';
  for (const hash of [`#${anchor}#token=secret`, `#token=secret#${anchor}`, `#token=secret&anchor=${anchor}`]) {
    assert.deepEqual(readPreviewFragment(hash), { token: 'secret', anchor });
  }
  const url = new URL(previewLink({ path: '/tmp/file #1.md', literal: '1' }, 'secret', 'café & tools'), 'http://localhost');
  assert.deepEqual(readPreviewFragment(url.hash), { token: 'secret', anchor: 'café & tools' });
  assert.equal(url.searchParams.get('path'), '/tmp/file #1.md');
  assert.ok(!url.search.includes('secret'));
  assert.deepEqual(readPreviewFragment('#caf%C3%A9'), { token: '', anchor: 'café' });
  assert.doesNotThrow(() => readPreviewFragment('#bad%encoding'));
});

test('document links separate anchors from paths and authenticate only local preview URLs', () => {
  const options = { token: 'secret', cwd: '/workspace/docs', origin: 'http://localhost:1234' };
  for (const [value, path] of [['other%20notes.md#section', 'other notes.md'], ['file:///tmp/a%23b.md#section', '/tmp/a#b.md'], ['https://example.com/notes.md#section', 'https://example.com/notes.md']]) {
    const url = new URL(linkTarget(value, options), options.origin);
    assert.equal(url.searchParams.get('path'), path);
    assert.deepEqual(readPreviewFragment(url.hash), { token: 'secret', anchor: 'section' });
  }
  for (const value of ['/preview.html?path=notes.md&cwd=%2Fother#section', 'http://localhost:1234/preview.html?path=notes.md&cwd=%2Fother#section#token=old']) {
    const url = new URL(linkTarget(value, options), options.origin);
    assert.equal(url.searchParams.get('path'), 'notes.md');
    assert.equal(url.searchParams.get('cwd'), '/other');
    assert.deepEqual(readPreviewFragment(url.hash), { token: 'secret', anchor: 'section' });
  }
  assert.equal(linkTarget('#section', { ...options, cwd: 'https://example.com/notes.md' }), '#section');
  for (const url of ['https://example.com/page#section', 'https://example.com/preview.html?path=notes.md#section']) assert.equal(linkTarget(url, options), url);
  const relative = new URL(linkTarget('other.md#section', { ...options, cwd: 'https://example.com/docs/start.md' }), options.origin);
  assert.equal(relative.searchParams.get('path'), 'https://example.com/docs/other.md');
});

test('file previews require authentication and allow reads outside the working directory including symlinks', async t => {
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
  for (const path of ['../outside.txt', join(dir, 'outside.txt'), 'escape.txt']) assert.equal((await get(path)).status, 200);
  const check = await fetch(`${server.origin}/api/files/exists`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['My Notes.md', '../outside.txt', 'escape.txt', 'missing', '.'] }) });
  assert.deepEqual((await check.json()).exists, [true, true, true, false, false]);
  assert.equal((await fetch(`${server.origin}/api/files/exists`, { method: 'POST' })).status, 401);
  assert.equal((await get('missing')).status, 404);
  assert.equal((await get('binary')).status, 415);
});

test('external Markdown is fetched on request and external failures are reported', async t => {
  const { createServer } = await import('node:http');
  const remote = createServer((req, res) => {
    if (req.url === '/notes.md') { res.setHeader('Content-Type', 'text/markdown'); res.end('# External notes'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const server = await startServer({ subscribe: () => () => {}, current: () => ({ session: { cwd: '/tmp' } }) });
  t.after(() => server.close());
  const path = `http://127.0.0.1:${remote.address().port}/notes.md`;
  assert.match(linkTarget(path), /^\/preview.html/);
  const get = path => fetch(`${server.origin}/api/file?${new URLSearchParams({ path })}`, { headers: { Authorization: `Bearer ${server.token}` } });
  const response = await get(path);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, '# External notes');
  assert.equal((await get(path + '/missing')).status, 502);
});

test('directory browsing starts at cwd, traverses parents and symlinks, and preserves literal file names', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-explorer-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  await mkdir(join(root, 'folder'), { recursive: true });
  await mkdir(join(dir, 'outside'));
  for (const name of ['.hidden', 'a # notes.txt', 'note:12']) await writeFile(join(root, name), name);
  await writeFile(join(dir, 'outside', 'external.txt'), 'Outside');
  await symlink(join(dir, 'outside'), join(root, 'linked-folder'));
  await symlink(join(dir, 'outside', 'external.txt'), join(root, 'linked-file'));
  await symlink(join(dir, 'missing'), join(root, 'broken'));
  const server = await startServer({ subscribe: () => () => {}, current: () => ({ session: { cwd: root } }) });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}` };
  const get = path => fetch(`${server.origin}/api/directory${path === undefined ? '' : `?${new URLSearchParams({ path })}`}`, { headers });
  assert.equal((await fetch(`${server.origin}/api/directory`)).status, 401);
  assert.equal((await fetch(`${server.origin}/api/directory`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  const listing = await (await get()).json();
  assert.equal(listing.path, root);
  assert.equal(listing.parent, dir);
  assert.deepEqual(listing.entries.slice(0, 2).map(entry => entry.name), ['folder', 'linked-folder']);
  assert.equal(listing.entries.find(entry => entry.name === 'broken').type, 'unavailable');
  assert.equal(listing.entries.find(entry => entry.name === 'linked-file').type, 'file');
  for (const entry of listing.entries.filter(entry => entry.type === 'file')) {
    const response = await fetch(`${server.origin}/api/file?${new URLSearchParams({ path: entry.path, literal: '1' })}`, { headers });
    assert.equal(response.status, 200, entry.name);
    assert.equal((await response.json()).content, entry.name === 'linked-file' ? 'Outside' : entry.name);
  }
  assert.deepEqual((await (await get('folder')).json()).entries, []);
  assert.equal((await (await get('..')).json()).path, dir);
  assert.equal((await (await get('../outside')).json()).entries[0].name, 'external.txt');
  const linked = await (await get('linked-folder')).json();
  assert.equal(linked.entries[0].name, 'external.txt');
  assert.equal(linked.parent, root);
  assert.equal((await (await get(parse(root).root)).json()).parent, null);
  assert.equal((await (await get(root)).json()).path, root);
  assert.equal((await get('missing')).status, 404);
  assert.equal((await get('.hidden')).status, 400);
  assert.equal((await get('')).status, 400);
  assert.equal((await get('\0')).status, 400);
});

test('HTML preview is isolated, serves relative assets, and requires authentication to create', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-html-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<html><h1>Example</h1></html>');
  await writeFile(join(dir, 'style.css'), 'h1 { color: blue }');
  await symlink('/etc/hosts', join(dir, 'escape.txt'));
  const server = await startServer({ subscribe: () => () => {}, current: () => ({ session: { cwd: dir } }) });
  t.after(() => server.close());
  assert.equal((await fetch(`${server.origin}/api/file?path=index.html`)).status, 401);
  const info = await (await fetch(`${server.origin}/api/file?path=index.html`, { headers: { Authorization: `Bearer ${server.token}` } })).json();
  const url = new URL(info.htmlUrl, server.origin);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), info.content);
  assert.match(page.headers.get('content-security-policy'), /sandbox allow-scripts;/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /allow-same-origin/);
  const css = await fetch(new URL('style.css', url), { headers: { Origin: 'null' } });
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css');
  assert.equal((await fetch(new URL('escape.txt', url))).status, 403);
  assert.equal((await fetch(new URL('/html/unknown/index.html', url))).status, 404);
});

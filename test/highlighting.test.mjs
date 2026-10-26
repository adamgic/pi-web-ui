import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nestingParts, palettes } from '../public/nesting.js';
import { languageFor } from '../public/highlighting.js';

const levelOf = (parts, text) => parts.find(part => part.text.includes(text))?.depth;

test('Python nesting follows indentation and brackets without counting strings/comments', () => {
  const source = 'def run():\n    value = {\n        "x": "} fake",\n    }\n    if value:\n        print(value) # } ignored\n    return value\nend = 1\n';
  const parts = nestingParts(source, 'python');
  assert.equal(parts.map(p => p.text).join(''), source);
  assert.equal(levelOf(parts, 'def run'), 0);
  assert.equal(levelOf(parts, 'value ='), 1);
  assert.equal(levelOf(parts, '"x"'), 2);
  assert.equal(levelOf(parts, 'if value'), 1);
  assert.equal(levelOf(parts, 'print('), 2);
  assert.equal(levelOf(parts, 'return value'), 1);
  assert.equal(levelOf(parts, 'end ='), 0);
  const multiline = 'def f():\n\ttext = """\n { [ }\n   fake indent\n"""\n\treturn text\nnext = 0';
  const triple = nestingParts(multiline, 'python');
  assert.equal(triple.map(p => p.text).join(''), multiline);
  assert.equal(levelOf(triple, 'return text'), 1);
  assert.equal(levelOf(triple, 'next ='), 0);
});

test('JSON keys and values alternate through objects and arrays, preserving exact bytes', () => {
  const source = '{ "root": {"child": [ {"leaf": 42}, true ]}, "name": "a\\\"}b" }';
  const parts = nestingParts(source, 'json');
  assert.equal(parts.map(p => p.text).join(''), source);
  assert.equal(levelOf(parts, '"root"'), 0);
  assert.equal(levelOf(parts, '"child"'), 2);
  assert.equal(levelOf(parts, '"leaf"'), 5);
  assert.equal(levelOf(parts, '42'), 6);
  assert.equal(levelOf(parts, 'true'), 4);
  assert.equal(levelOf(parts, '"name"'), 0);
  assert.equal(levelOf(parts, '"a\\\"}b"'), 1);
  assert.equal(nestingParts('{"x":1}', 'json').find(p => p.text === '1')?.depth, 1);
});

test('brace languages ignore quoted delimiters, comments and JavaScript regexes', () => {
  const source = 'function f() {\n const value = {x: "}"}; /* {{{ */\n const regex = /[{}]/g;\n if (value) { run(); }\n}\nend();';
  const parts = nestingParts(source, 'javascript');
  assert.equal(parts.map(p => p.text).join(''), source);
  assert.equal(levelOf(parts, 'const value'), 1);
  assert.equal(levelOf(parts, '"}"'), 2);
  assert.equal(levelOf(parts, 'run('), 2);
  assert.equal(levelOf(parts, 'end('), 0);
  for (const language of ['java', 'go', 'rust', 'cpp', 'css']) {
    const parts = nestingParts('outer { inner { value } } tail', language);
    assert.equal(levelOf(parts, 'value'), 2);
    assert.equal(levelOf(parts, 'tail'), 0);
  }
  const yaml = nestingParts('root:\n  nested:\n    value: yes\nend: no', 'yaml');
  assert.equal(levelOf(yaml, 'value'), 2);
  assert.equal(levelOf(yaml, 'end'), 0);
});

function luminance(hex) {
  const rgb = hex.match(/[a-f0-9]{2}/gi).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
test('both palettes meet 4.5:1 text contrast on UI and code backgrounds', async () => {
  const css = await readFile(new URL('../public/highlighting.css', import.meta.url), 'utf8');
  for (const [theme, backgrounds] of Object.entries({ light: ['#f8faf9', '#eff3f1'], dark: ['#111719', '#0d1315'] })) {
    for (const color of palettes[theme]) {
      assert.ok(css.includes(color));
      for (const bg of backgrounds) {
        const [hi, lo] = [luminance(color), luminance(bg)].sort((a, b) => b - a);
        assert.ok((hi + .05) / (lo + .05) >= 4.5, `${theme} ${color} on ${bg}`);
      }
    }
    assert.equal(new Set(palettes[theme]).size, 5);
  }
});

test('language detection supports common file extensions', () => {
  for (const [file, language] of Object.entries({ 'script.py': 'python', 'config.JSON': 'json', 'module.mjs': 'javascript', 'types.ts': 'typescript', 'main.rs': 'rust', 'config.yml': 'yaml', 'unknown.xyz': 'plaintext' })) assert.equal(languageFor(file), language);
});

test('HTML tag nesting preserves markup and handles void tags and script text', () => {
  const source = '<html><body><img src="a>b"><section>text</section><script>if (a < b) x = "<fake>";</script></body></html>';
  const parts = nestingParts(source, 'xml');
  assert.equal(parts.map(p => p.text).join(''), source);
  assert.equal(levelOf(parts, '<img'), 2);
  assert.equal(levelOf(parts, '<section>'), 2);
  assert.equal(levelOf(parts, 'text'), 3);
  assert.equal(levelOf(parts, 'if (a'), 3);
  assert.equal(levelOf(parts, '</html>'), 0);
});

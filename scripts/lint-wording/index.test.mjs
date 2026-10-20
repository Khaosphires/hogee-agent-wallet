import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkText, lint } from './index.mjs';

test('case, punctuation, word boundaries, Chinese and line numbers', () => {
  const rows = checkText('issuer tokens coincidence\nA STABLECOIN.\n禁止发行');
  assert.deepEqual(rows.map(x => [x.line, x.term]), [[2, 'stablecoin'], [3, '发行']]);
});

test('an exception does not hide another banned term on the same line', () => {
  const rows = checkText('GitHub issue about a coin; Free Trade; x-callback-token',
    ['GitHub issue', 'Free Trade', 'x-callback-token']);
  assert.deepEqual(rows.map(x => x.term), ['coin']);
  assert.equal(checkText('budget units; aligned with; milestone release').length, 0);
});

test('source and disclaimer phrases do not exempt positive advice claims', () => {
  const allowed = ['trade name', 'not legal or tax advice'];
  assert.deepEqual(checkText('Register a trade name. This is not legal or tax advice.', allowed), []);
  assert.deepEqual(checkText('not legal or tax advice; we provide tax advice', allowed).map(x => x.term), ['tax advice']);
  assert.deepEqual(checkText('trade name; trade a coin', allowed).map(x => x.term), ['coin', 'trade']);
});

test('scoped scan, exclusions, CLI failure and successful clean rerun', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hogee-wording-'));
  try {
    const write = async (name, content) => {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    };
    await write('apps/web/page.tsx', 'const label = "token";');
    await write('apps/web/node_modules/ignored.js', 'coin');
    await write('apps/web/.env.test', 'coin');
    await write('docs/compliance/wording.md', 'coin');
    await write('data/notes.txt', 'coin');
    await write('data/demo.json', '{"label":"budget units"}');
    const result = await lint(root);
    assert.equal(result.files, 2);
    assert.deepEqual(result.findings.map(x => [x.file, x.line, x.term]), [['apps/web/page.tsx', 1, 'token']]);
    const cli = fileURLToPath(new URL('./index.mjs', import.meta.url));
    const failed = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /apps\/web\/page.tsx:1:/);
    await write('apps/web/page.tsx', 'const label = "budget units";');
    const passed = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
    assert.equal(passed.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

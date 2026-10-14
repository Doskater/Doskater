import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package supports Node 20 fallback websocket and syntax-checks microstructure files', async () => {
  const pkg=JSON.parse(await readFile(new URL('../package.json', import.meta.url),'utf8'));
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.dependencies.ws, '^8.18.3');
  assert.match(pkg.scripts.check, /microstructure\/\*\.js/);
});

test('package exposes production start and smoke commands', async () => {
  const pkg=JSON.parse(await readFile(new URL('../package.json', import.meta.url),'utf8'));
  assert.equal(pkg.scripts.start,'node index.js');
  assert.equal(pkg.scripts.smoke,'node scripts/smoke.js');
});

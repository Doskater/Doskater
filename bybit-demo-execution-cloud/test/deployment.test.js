import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('deployment README documents exactly the two Bybit Demo secret variable names and no host override', async () => {
  let text = '';
  try { text = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8'); } catch {}
  assert.ok(text, 'README.md should exist');
  assert.match(text, /BYBIT_DEMO_API_KEY/);
  assert.match(text, /BYBIT_DEMO_API_SECRET/);
  const envNames = [...text.matchAll(/\bBYBIT_[A-Z0-9_]+\b/g)].map(match => match[0]);
  assert.deepEqual([...new Set(envNames)].sort(), ['BYBIT_DEMO_API_KEY', 'BYBIT_DEMO_API_SECRET']);
  assert.doesNotMatch(text, /BYBIT_(?:HOST|URL|BASE)/);
});

test('package exposes Render-compatible start test and check scripts', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.match(pkg.scripts.check, /node --check server\.js/);
  assert.equal(pkg.engines.node, '>=20');
});

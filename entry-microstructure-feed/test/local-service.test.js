import test from 'node:test';
import assert from 'node:assert/strict';

async function loadModule() {
  try { return await import('../local-service.js'); }
  catch { return null; }
}

test('local lifecycle uses loopback and state outside the repository', async () => {
  const mod = await loadModule();
  assert.ok(mod, 'local-service module should exist');
  const config = mod.getLocalServiceConfig({ home: '/Users/tester' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8791);
  assert.equal(config.stateDir, '/Users/tester/Library/Application Support/entry-microstructure-feed');
  assert.equal(config.pidFile, '/Users/tester/Library/Application Support/entry-microstructure-feed/service.json');
  assert.equal(config.logFile, '/Users/tester/Library/Application Support/entry-microstructure-feed/service.log');
});

test('readLocalStatus reports stopped when state file is absent', async () => {
  const mod = await loadModule();
  assert.ok(mod);
  const fsImpl = { readFile: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; } };
  const status = await mod.readLocalStatus({ fsImpl, fetchImpl: async () => { throw new Error('should_not_fetch'); } });
  assert.equal(status.running, false);
  assert.equal(status.healthy, false);
});

test('readLocalStatus validates both pid liveness and localhost health identity', async () => {
  const mod = await loadModule();
  assert.ok(mod);
  const fsImpl = { readFile: async () => JSON.stringify({ pid: 4321, port: 8791, host: '127.0.0.1' }) };
  const killImpl = (pid, signal) => { assert.equal(pid, 4321); assert.equal(signal, 0); };
  const fetchImpl = async url => {
    assert.equal(url, 'http://127.0.0.1:8791/healthz');
    return { ok: true, json: async () => ({ status: 'ok', service: 'entry-microstructure-feed' }) };
  };
  const status = await mod.readLocalStatus({ fsImpl, killImpl, fetchImpl });
  assert.equal(status.running, true);
  assert.equal(status.healthy, true);
  assert.equal(status.pid, 4321);
});

import { promises as fs, openSync, closeSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'entry-microstructure-feed';
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function getLocalServiceConfig({ home = os.homedir(), env = process.env } = {}) {
  const host = '127.0.0.1';
  const rawPort = env.ENTRY_MICROSTRUCTURE_PORT ?? '8791';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_local_port');
  const stateDir = env.ENTRY_MICROSTRUCTURE_STATE_DIR
    ?? path.join(home, 'Library', 'Application Support', SERVICE_NAME);
  return {
    host,
    port,
    url: `http://${host}:${port}`,
    stateDir,
    pidFile: path.join(stateDir, 'service.json'),
    logFile: path.join(stateDir, 'service.log'),
    serverFile: path.join(BASE_DIR, 'server.js'),
    cwd: BASE_DIR
  };
}

export function ensureRuntimeDependencies({
  config = getLocalServiceConfig(),
  existsImpl = existsSync,
  spawnSyncImpl = spawnSync,
  platform = process.platform
} = {}) {
  const marker = path.join(config.cwd, 'node_modules', 'ws', 'package.json');
  if (existsImpl(marker)) return { installed: false };
  const command = platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSyncImpl(command, ['install', '--omit=dev', '--ignore-scripts'], { cwd: config.cwd, stdio: 'inherit' });
  if (result?.error || result?.status !== 0 || !existsImpl(marker)) throw new Error('local_dependency_install_failed');
  return { installed: true };
}


async function readState(fsImpl, pidFile) {
  try {
    const parsed = JSON.parse(await fsImpl.readFile(pidFile, 'utf8'));
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

function isPidAlive(pid, killImpl) {
  try { killImpl(pid, 0); return true; }
  catch { return false; }
}

export async function readLocalStatus({
  config = getLocalServiceConfig(),
  fsImpl = fs,
  killImpl = process.kill.bind(process),
  fetchImpl = fetch
} = {}) {
  const state = await readState(fsImpl, config.pidFile);
  if (!state) return { running: false, healthy: false, pid: null, url: config.url, logFile: config.logFile };
  if (!isPidAlive(state.pid, killImpl)) {
    return { running: false, healthy: false, pid: state.pid, staleState: true, url: config.url, logFile: config.logFile };
  }
  let healthy = false;
  try {
    const response = await fetchImpl(`${config.url}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (response?.ok) {
      const body = await response.json();
      healthy = body?.status === 'ok' && body?.service === SERVICE_NAME;
    }
  } catch {}
  return { running: true, healthy, pid: state.pid, url: config.url, logFile: config.logFile };
}

export async function startLocalService({
  config = getLocalServiceConfig(),
  fsImpl = fs,
  spawnImpl = spawn,
  openSyncImpl = openSync,
  closeSyncImpl = closeSync,
  fetchImpl = fetch,
  killImpl = process.kill.bind(process),
  env = process.env,
  startupTimeoutMs = 12_000
} = {}) {
  const current = await readLocalStatus({ config, fsImpl, fetchImpl, killImpl });
  if (current.running && current.healthy) return { ...current, alreadyRunning: true };
  if (current.running && !current.healthy) throw new Error('local_service_pid_alive_but_health_invalid');

  await fsImpl.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const logFd = openSyncImpl(config.logFile, 'a');
  let child;
  try {
    child = spawnImpl(process.execPath, [config.serverFile], {
      cwd: config.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...env, HOST: config.host, PORT: String(config.port), MICROSTRUCTURE_FEED_TOKEN: '' }
    });
    child.unref();
  } finally {
    closeSyncImpl(logFd);
  }
  if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error('local_service_spawn_failed');
  await fsImpl.writeFile(config.pidFile, JSON.stringify({ pid: child.pid, host: config.host, port: config.port, startedAt: new Date().toISOString() }), { mode: 0o600 });

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const status = await readLocalStatus({ config, fsImpl, fetchImpl, killImpl });
    if (status.running && status.healthy) return { ...status, started: true };
    if (!status.running) break;
    await sleep(150);
  }
  try { if (isPidAlive(child.pid, killImpl)) killImpl(child.pid, 'SIGTERM'); } catch {}
  try { await fsImpl.unlink(config.pidFile); } catch {}
  throw new Error('local_service_start_timeout');
}

export async function stopLocalService({
  config = getLocalServiceConfig(),
  fsImpl = fs,
  fetchImpl = fetch,
  killImpl = process.kill.bind(process),
  stopTimeoutMs = 5_000
} = {}) {
  const status = await readLocalStatus({ config, fsImpl, fetchImpl, killImpl });
  if (!status.running) {
    try { await fsImpl.unlink(config.pidFile); } catch {}
    return { ...status, stopped: true, alreadyStopped: true };
  }
  if (!status.healthy) return { ...status, stopped: false, reason: 'pid_alive_health_mismatch' };
  killImpl(status.pid, 'SIGTERM');
  const deadline = Date.now() + stopTimeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(status.pid, killImpl)) break;
    await sleep(100);
  }
  const alive = isPidAlive(status.pid, killImpl);
  if (!alive) {
    try { await fsImpl.unlink(config.pidFile); } catch {}
  }
  return { running: alive, healthy: false, pid: status.pid, stopped: !alive, url: config.url, logFile: config.logFile };
}

async function runCli() {
  const command = process.argv[2] ?? 'status';
  let result;
  if (command === 'start' || command === 'ensure') {
    ensureRuntimeDependencies();
    result = await startLocalService();
  } else if (command === 'status') result = await readLocalStatus();
  else if (command === 'stop') result = await stopLocalService();
  else throw new Error('usage: node local-service.js <start|ensure|status|stop>');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === 'status' && !result.healthy) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch(error => {
    process.stderr.write(`${JSON.stringify({ error: error?.message ?? 'local_service_error' })}\n`);
    process.exitCode = 1;
  });
}

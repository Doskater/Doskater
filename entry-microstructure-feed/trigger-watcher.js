import { promises as fs, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SYMBOLS, normalizeSymbol } from './config.js';
import {createCandidate,appendEntryEvent} from './entry-journal.js';
import {
  getLocalServiceConfig,
  ensureRuntimeDependencies,
  startLocalService
} from './local-service.js';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function getWatcherConfig({ home = os.homedir(), env = process.env } = {}) {
  const service = getLocalServiceConfig({ home, env });
  const pollMs = Number(env.ENTRY_TRIGGER_WATCHER_POLL_MS ?? 3000);
  if (!Number.isInteger(pollMs) || pollMs < 500) throw new Error('invalid_watcher_poll_ms');
  return {
    stateDir: service.stateDir,
    setupsFile: path.join(service.stateDir, 'watcher-setups.json'),
    pidFile: path.join(service.stateDir, 'watcher.json'),
    logFile: path.join(service.stateDir, 'watcher.log'),
    journalFile: path.join(service.stateDir, 'entry-journal.jsonl'),
    watcherFile: path.join(BASE_DIR, 'trigger-watcher.js'),
    cwd: BASE_DIR,
    feedUrl: service.url,
    pollMs
  };
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`invalid_${name}`);
  return number;
}

function nonNegativeInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`invalid_${name}`);
  return number;
}

export function normalizeSetup(input = {}) {
  const side = String(input.side ?? '').toLowerCase();
  if (!['long', 'short'].includes(side)) throw new Error('invalid_side');
  const minImbalance = Number(input.minImbalance ?? 0.30);
  if (!Number.isFinite(minImbalance) || minImbalance < 0 || minImbalance > 1) throw new Error('invalid_min_imbalance');
  const confirmationsRequired = Number(input.confirmationsRequired ?? 2);
  if (!Number.isInteger(confirmationsRequired) || confirmationsRequired < 1 || confirmationsRequired > 10) throw new Error('invalid_confirmations_required');
  return {
    symbol: normalizeSymbol(input.symbol),
    side,
    triggerPrice: positiveNumber(input.triggerPrice, 'trigger_price'),
    holdMs: nonNegativeInt(input.holdMs ?? 30_000, 'hold_ms'),
    minImbalance,
    confirmationsRequired,
    confirmationIntervalMs: nonNegativeInt(input.confirmationIntervalMs ?? 12_000, 'confirmation_interval_ms'),
    requireImpact: input.requireImpact !== false,
    absorptionVeto: input.absorptionVeto !== false,
    enabled: input.enabled !== false
  };
}

export function createSetupState() {
  return { levelSince: null, lastConfirmationAt: null, confirmationCount: 0, latched: false };
}

function priceCondition(setup, price) {
  if (!Number.isFinite(price)) return false;
  return setup.side === 'long' ? price > setup.triggerPrice : price < setup.triggerPrice;
}

function microConditionsPass(setup, snapshot) {
  if (snapshot?.runtime !== 'FULL_EVENT_STREAM') return false;
  const features = snapshot?.windows?.['60000'];
  if (!features) return false;
  const aggressor = features.aggressor;
  if (aggressor?.quality !== 'ok' || !Number.isFinite(Number(aggressor?.imbalance))) return false;
  const imbalance = Number(aggressor.imbalance);
  if (setup.side === 'long' && !(imbalance > setup.minImbalance)) return false;
  if (setup.side === 'short' && !(imbalance < -setup.minImbalance)) return false;
  if (setup.requireImpact) {
    const expected = setup.side === 'long' ? 'buy_more_efficient' : 'sell_more_efficient';
    if (features.impactAsymmetry?.direction !== expected) return false;
  }
  if (setup.absorptionVeto) {
    const veto = setup.side === 'long' ? 'sell' : 'buy';
    if (features.refill?.absorptionDirection === veto) return false;
  }
  return true;
}

export function evaluateSetup(rawSetup, snapshot, previousState = createSetupState(), now = Date.now()) {
  const setup = normalizeSetup(rawSetup);
  const price = Number(snapshot?.currentMid);
  const state = { ...createSetupState(), ...previousState };

  if (!priceCondition(setup, price)) {
    return { alert: false, state: createSetupState(), reason: 'price_not_triggered' };
  }
  if (state.latched) return { alert: false, state, reason: 'latched' };
  if (state.levelSince === null) state.levelSince = now;
  if (now - state.levelSince < setup.holdMs) return { alert: false, state, reason: 'holding' };

  if (!microConditionsPass(setup, snapshot)) {
    state.confirmationCount = 0;
    state.lastConfirmationAt = null;
    return { alert: false, state, reason: 'micro_not_confirmed' };
  }

  if (state.lastConfirmationAt !== null && now - state.lastConfirmationAt < setup.confirmationIntervalMs) {
    return { alert: false, state, reason: 'confirmation_spacing' };
  }

  state.confirmationCount += 1;
  state.lastConfirmationAt = now;
  if (state.confirmationCount >= setup.confirmationsRequired) {
    state.latched = true;
    return { alert: true, state, reason: 'confirmed' };
  }
  return { alert: false, state, reason: 'confirmation_recorded' };
}


export async function processSetupSnapshot(rawSetup,snapshot,previousState=createSetupState(),{
  now=Date.now,writeCandidate,notify=sendMacNotification
}={}) {
  const setup=normalizeSetup(rawSetup);
  const result=evaluateSetup(setup,snapshot,previousState,now());
  if(!result.alert)return result;
  const candidate=createCandidate(setup,snapshot,{now});
  try { await writeCandidate(candidate); }
  catch(error) {
    return {alert:false,state:{...result.state,latched:false,lastConfirmationAt:null,confirmationCount:setup.confirmationsRequired-1},
      reason:'candidate_write_failed',persistenceError:error?.message ?? 'journal_error'};
  }
  try {await notify(buildNotification(setup,snapshot));}
  catch(error){return {...result,candidate,notificationError:error?.message ?? 'notification_error'};}
  return {...result,candidate};
}

export async function readSetups({ config = getWatcherConfig(), fsImpl = fs } = {}) {
  try {
    const parsed = JSON.parse(await fsImpl.readFile(config.setupsFile, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSetup);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeSetups(rows, { config = getWatcherConfig(), fsImpl = fs } = {}) {
  await fsImpl.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await fsImpl.writeFile(config.setupsFile, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
}

export async function upsertSetup(input, options = {}) {
  const setup = normalizeSetup(input);
  const rows = await readSetups(options);
  const index = rows.findIndex(row => row.symbol === setup.symbol && row.side === setup.side);
  if (index >= 0) rows[index] = setup;
  else rows.push(setup);
  await writeSetups(rows, options);
  return setup;
}

export async function removeSetup(symbol, options = {}) {
  const normalized = normalizeSymbol(symbol);
  const rows = await readSetups(options);
  const next = rows.filter(row => row.symbol !== normalized);
  await writeSetups(next, options);
  return { removed: next.length !== rows.length, symbol: normalized };
}

function pidAlive(pid, killImpl = process.kill.bind(process)) {
  try { killImpl(pid, 0); return true; } catch { return false; }
}

async function readPid(config, fsImpl = fs) {
  try {
    const parsed = JSON.parse(await fsImpl.readFile(config.pidFile, 'utf8'));
    return Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed : null;
  } catch { return null; }
}

export async function readWatcherStatus({ config = getWatcherConfig(), fsImpl = fs, killImpl = process.kill.bind(process) } = {}) {
  const row = await readPid(config, fsImpl);
  const running = Boolean(row && pidAlive(row.pid, killImpl));
  const setups = await readSetups({ config, fsImpl });
  return { running, pid: running ? row.pid : null, setupCount: setups.length, setupsFile: config.setupsFile, logFile: config.logFile };
}

export async function startWatcher({ config = getWatcherConfig(), fsImpl = fs, spawnImpl = spawn, openSyncImpl = openSync, closeSyncImpl = closeSync } = {}) {
  const current = await readWatcherStatus({ config, fsImpl });
  if (current.running) return { ...current, alreadyRunning: true };
  await fsImpl.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const logFd = openSyncImpl(config.logFile, 'a');
  let child;
  try {
    child = spawnImpl(process.execPath, [config.watcherFile, 'daemon'], {
      cwd: config.cwd, detached: true, stdio: ['ignore', logFd, logFd], env: process.env
    });
    child.unref();
  } finally { closeSyncImpl(logFd); }
  if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error('watcher_spawn_failed');
  await fsImpl.writeFile(config.pidFile, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  await sleep(100);
  return { ...(await readWatcherStatus({ config, fsImpl })), started: true };
}

export async function stopWatcher({ config = getWatcherConfig(), fsImpl = fs, killImpl = process.kill.bind(process) } = {}) {
  const status = await readWatcherStatus({ config, fsImpl, killImpl });
  if (!status.running) {
    try { await fsImpl.unlink(config.pidFile); } catch {}
    return { ...status, stopped: true, alreadyStopped: true };
  }
  killImpl(status.pid, 'SIGTERM');
  for (let i = 0; i < 50 && pidAlive(status.pid, killImpl); i++) await sleep(100);
  const running = pidAlive(status.pid, killImpl);
  if (!running) { try { await fsImpl.unlink(config.pidFile); } catch {} }
  return { ...status, running, stopped: !running };
}

function appleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function buildNotification(setup, snapshot) {
  const features = snapshot.windows?.['60000'] ?? {};
  const imbalance = Number(features.aggressor?.imbalance);
  const price = Number(snapshot.currentMid);
  const efficiency = setup.side === 'long' ? 'buy-efficient' : 'sell-efficient';
  return {
    title: `🟢 ${setup.symbol} ${setup.side.toUpperCase()} — НОВЫЙ СИГНАЛ`,
    message: `price ${Number.isFinite(price) ? price : '?'} | imbalance ${Number.isFinite(imbalance) ? `${imbalance >= 0 ? '+' : ''}${imbalance.toFixed(2)}` : '?'} | ${efficiency} | FULL`
  };
}

export function sendMacNotification(notification, { spawnImpl = spawn } = {}) {
  const script = `display notification ${appleScriptString(notification.message)} with title ${appleScriptString(notification.title)}`;
  const options = { stdio: 'ignore', detached: true };
  const notificationChild = spawnImpl('/usr/bin/osascript', ['-e', script], options);
  notificationChild.unref?.();
  const voiceChild = spawnImpl('/usr/bin/say', ['-v', 'Milena', 'Найдены новые сигналы'], options);
  voiceChild.unref?.();
  return notification;
}

async function appendLog(config, event) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await fs.appendFile(config.logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

async function ensureFeedSymbols(config, symbols) {
  if (!symbols.length) return;
  const response = await fetch(`${config.feedUrl}/v1/watchlist/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbols }), signal: AbortSignal.timeout(2500)
  });
  if (!response.ok) throw new Error(`feed_ensure_failed_${response.status}`);
}

export function dynamicSymbolsForRefresh(setups = []) {
  const core = new Set(CORE_SYMBOLS);
  return [...new Set(setups.map(row => normalizeSymbol(row.symbol)).filter(symbol => !core.has(symbol)))];
}

export function shouldRefreshSubscriptions(lastRefreshAt, now = Date.now(), intervalMs = 300_000) {
  return now - lastRefreshAt >= intervalMs;
}

async function fetchSnapshot(config, symbol) {
  const response = await fetch(`${config.feedUrl}/v1/microstructure/${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`snapshot_failed_${response.status}`);
  return response.json();
}

export async function resolveSnapshotPrice(snapshot, symbol, { fetchImpl = fetch } = {}) {
  const local = Number(snapshot?.currentMid);
  if (Number.isFinite(local) && local > 0) return local;
  const normalized = normalizeSymbol(symbol);
  const response = await fetchImpl(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(normalized)}`, { signal: AbortSignal.timeout(2000) });
  if (!response?.ok) throw new Error(`price_fallback_failed_${response?.status ?? 'network'}`);
  const body = await response.json();
  const price = Number(body?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('price_fallback_invalid');
  return price;
}

function signature(setup) {
  return JSON.stringify(setup);
}

export async function runWatcherDaemon({ config = getWatcherConfig() } = {}) {
  ensureRuntimeDependencies();
  await startLocalService();
  const states = new Map();
  let lastSubscriptionRefreshAt = 0;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await appendLog(config, { event: 'watcher_started', pollMs: config.pollMs });

  while (!stopping) {
    try {
      const setups = (await readSetups({ config })).filter(row => row.enabled);
      const loopNow = Date.now();
      if (shouldRefreshSubscriptions(lastSubscriptionRefreshAt, loopNow)) {
        await ensureFeedSymbols(config, dynamicSymbolsForRefresh(setups));
        lastSubscriptionRefreshAt = loopNow;
      }
      for (const setup of setups) {
        try {
          const snapshot = await fetchSnapshot(config, setup.symbol);
          snapshot.currentMid = await resolveSnapshotPrice(snapshot, setup.symbol);
          const stateKey = `${setup.symbol}:${setup.side}`;
          const prior = states.get(stateKey);
          const sig = signature(setup);
          const state = prior?.signature === sig ? prior.state : createSetupState();
          const result = await processSetupSnapshot(setup, snapshot, state, {
            writeCandidate: candidate => appendEntryEvent({event:'ENTRY_CANDIDATE',timestamp:candidate.detectedAt,candidateId:candidate.candidateId,setupId:candidate.setupId,candidate}, {journalFile:config.journalFile})
          });
          states.set(stateKey, { signature: sig, state: result.state });
          if (result.persistenceError) await appendLog(config, {event:'candidate_write_failed',symbol:setup.symbol,message:result.persistenceError});
          if (result.notificationError) await appendLog(config, {event:'notification_failed',symbol:setup.symbol,message:result.notificationError});
          if (result.alert) {
            const notification = buildNotification(setup, snapshot);
            await appendLog(config, { event: 'trigger_confirmed', candidateId: result.candidate.candidateId, setupId: result.candidate.setupId, symbol: setup.symbol, side: setup.side, price: snapshot.currentMid, notification });
          }
        } catch (error) {
          await appendLog(config, { event: 'symbol_check_failed', symbol: setup.symbol, message: error?.message ?? 'error' });
        }
      }
      const active = new Set(setups.map(row => `${row.symbol}:${row.side}`));
      for (const stateKey of states.keys()) if (!active.has(stateKey)) states.delete(stateKey);
    } catch (error) {
      await appendLog(config, { event: 'watcher_loop_failed', message: error?.message ?? 'error' });
    }
    if (!stopping) await sleep(config.pollMs);
  }
  try { await fs.unlink(config.pidFile); } catch {}
  await appendLog(config, { event: 'watcher_stopped' });
}

function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

function setupFromFlags(flags) {
  return normalizeSetup({
    symbol: flags.symbol,
    side: flags.side,
    triggerPrice: flags.trigger,
    holdMs: flags['hold-ms'] === undefined ? undefined : Number(flags['hold-ms']),
    minImbalance: flags['min-imbalance'] === undefined ? undefined : Number(flags['min-imbalance']),
    confirmationsRequired: flags.confirmations === undefined ? undefined : Number(flags.confirmations),
    confirmationIntervalMs: flags['confirmation-interval-ms'] === undefined ? undefined : Number(flags['confirmation-interval-ms']),
    requireImpact: flags['no-impact'] ? false : undefined,
    absorptionVeto: flags['no-absorption-veto'] ? false : undefined
  });
}

async function runCli() {
  const command = process.argv[2] ?? 'status';
  const config = getWatcherConfig();
  if (command === 'daemon') return runWatcherDaemon({ config });
  if (command === 'ensure') {
    const setup = setupFromFlags(parseArgs(process.argv.slice(3)));
    ensureRuntimeDependencies();
    await startLocalService();
    await ensureFeedSymbols(config, [setup.symbol]);
    await upsertSetup(setup, { config });
    const watcher = await startWatcher({ config });
    process.stdout.write(`${JSON.stringify({ setup, watcher }, null, 2)}\n`);
    return;
  }
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(await readSetups({ config }), null, 2)}\n`);
    return;
  }
  if (command === 'remove') {
    const flags = parseArgs(process.argv.slice(3));
    process.stdout.write(`${JSON.stringify(await removeSetup(flags.symbol, { config }), null, 2)}\n`);
    return;
  }
  if (command === 'status') {
    const status = await readWatcherStatus({ config });
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    if (!status.running) process.exitCode = 1;
    return;
  }
  if (command === 'stop') {
    process.stdout.write(`${JSON.stringify(await stopWatcher({ config }), null, 2)}\n`);
    return;
  }
  throw new Error('usage: trigger-watcher.js <ensure|list|remove|status|stop> [--symbol SYMBOL --side long|short --trigger PRICE]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch(error => {
    process.stderr.write(`${JSON.stringify({ error: error?.message ?? 'watcher_error' })}\n`);
    process.exitCode = 1;
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';

async function loadModule() {
  try { return await import('../trigger-watcher.js'); }
  catch { return null; }
}

function longSnapshot({ price=107, runtime='FULL_EVENT_STREAM', imbalance=0.5, impact='buy_more_efficient', absorption='buy' } = {}) {
  return {
    symbol:'SOLUSDT', currentMid:price, runtime,
    windows:{'60000':{
      aggressor:{imbalance,quality:'ok'},
      impactAsymmetry:{direction:impact,quality:'ok'},
      refill:{absorptionDirection:absorption,quality:'ok'}
    }}
  };
}

function shortSnapshot({ price=79_000, runtime='FULL_EVENT_STREAM', imbalance=-0.5, impact='sell_more_efficient', absorption='sell' } = {}) {
  return {
    symbol:'BTCUSDT', currentMid:price, runtime,
    windows:{'60000':{
      aggressor:{imbalance,quality:'ok'},
      impactAsymmetry:{direction:impact,quality:'ok'},
      refill:{absorptionDirection:absorption,quality:'ok'}
    }}
  };
}

test('watcher module exists and stores state outside repository', async () => {
  const mod=await loadModule();
  assert.ok(mod,'trigger-watcher module should exist');
  const config=mod.getWatcherConfig({home:'/Users/tester'});
  assert.equal(config.stateDir,'/Users/tester/Library/Application Support/entry-microstructure-feed');
  assert.equal(config.setupsFile,'/Users/tester/Library/Application Support/entry-microstructure-feed/watcher-setups.json');
  assert.equal(config.pidFile,'/Users/tester/Library/Application Support/entry-microstructure-feed/watcher.json');
  assert.equal(config.logFile,'/Users/tester/Library/Application Support/entry-microstructure-feed/watcher.log');
});

test('normalizes a generic long setup with conservative defaults', async () => {
  const mod=await loadModule(); assert.ok(mod);
  const setup=mod.normalizeSetup({symbol:'nearusdt',side:'long',triggerPrice:5.25});
  assert.deepEqual(setup,{
    symbol:'NEARUSDT',side:'long',triggerPrice:5.25,holdMs:30_000,minImbalance:0.30,
    confirmationsRequired:2,confirmationIntervalMs:12_000,requireImpact:true,absorptionVeto:true,enabled:true
  });
});

test('long setup requires continuous hold and two spaced micro confirmations before alert', async () => {
  const mod=await loadModule(); assert.ok(mod);
  const setup=mod.normalizeSetup({symbol:'SOLUSDT',side:'long',triggerPrice:106.5});
  let state=mod.createSetupState();

  let result=mod.evaluateSetup(setup,longSnapshot({price:106.6}),state,0);
  state=result.state; assert.equal(result.alert,false); assert.equal(state.levelSince,0);

  result=mod.evaluateSetup(setup,longSnapshot({price:106.7}),state,29_000);
  state=result.state; assert.equal(result.alert,false); assert.equal(state.confirmationCount,0);

  result=mod.evaluateSetup(setup,longSnapshot({price:106.8}),state,30_000);
  state=result.state; assert.equal(result.alert,false); assert.equal(state.confirmationCount,1);

  result=mod.evaluateSetup(setup,longSnapshot({price:106.9}),state,41_000);
  state=result.state; assert.equal(result.alert,false); assert.equal(state.confirmationCount,1);

  result=mod.evaluateSetup(setup,longSnapshot({price:107}),state,42_000);
  assert.equal(result.alert,true); assert.equal(result.state.latched,true); assert.equal(result.state.confirmationCount,2);
});

test('long setup resets hold on price failure and vetoes sell absorption', async () => {
  const mod=await loadModule(); assert.ok(mod);
  const setup=mod.normalizeSetup({symbol:'SOLUSDT',side:'long',triggerPrice:106.5});
  let state=mod.createSetupState();
  state=mod.evaluateSetup(setup,longSnapshot({price:106.7}),state,0).state;
  state=mod.evaluateSetup(setup,longSnapshot({price:106.4}),state,20_000).state;
  assert.equal(state.levelSince,null);
  state=mod.evaluateSetup(setup,longSnapshot({price:106.8,absorption:'sell'}),state,30_000).state;
  const result=mod.evaluateSetup(setup,longSnapshot({price:106.9,absorption:'sell'}),state,60_000);
  assert.equal(result.alert,false); assert.equal(result.state.confirmationCount,0);
});

test('short setup mirrors imbalance impact and absorption rules', async () => {
  const mod=await loadModule(); assert.ok(mod);
  const setup=mod.normalizeSetup({symbol:'BTCUSDT',side:'short',triggerPrice:80_000,holdMs:0,confirmationIntervalMs:1});
  let state=mod.createSetupState();
  let result=mod.evaluateSetup(setup,shortSnapshot({price:79_900}),state,100);
  state=result.state; assert.equal(state.confirmationCount,1); assert.equal(result.alert,false);
  result=mod.evaluateSetup(setup,shortSnapshot({price:79_800}),state,101);
  assert.equal(result.alert,true);

  const veto=mod.evaluateSetup(setup,shortSnapshot({price:79_700,absorption:'buy'}),mod.createSetupState(),200);
  assert.equal(veto.alert,false); assert.equal(veto.state.confirmationCount,0);
});

test('latched setup rearms only after price invalidates trigger', async () => {
  const mod=await loadModule(); assert.ok(mod);
  const setup=mod.normalizeSetup({symbol:'SOLUSDT',side:'long',triggerPrice:106.5,holdMs:0,confirmationIntervalMs:1});
  let state={...mod.createSetupState(),latched:true,confirmationCount:2};
  let result=mod.evaluateSetup(setup,longSnapshot({price:107}),state,10);
  assert.equal(result.alert,false); assert.equal(result.state.latched,true);
  result=mod.evaluateSetup(setup,longSnapshot({price:106.4}),result.state,11);
  assert.equal(result.state.latched,false); assert.equal(result.state.levelSince,null); assert.equal(result.state.confirmationCount,0);
});

test('upsert and remove persist arbitrary future coin setups', async () => {
  const mod=await loadModule(); assert.ok(mod);
  let stored='';
  const fsImpl={
    mkdir:async()=>{},
    readFile:async()=>{ if(!stored){const e=new Error('missing');e.code='ENOENT';throw e;} return stored; },
    writeFile:async(_path,value)=>{stored=String(value);},rename:async()=>{},unlink:async()=>{}
  };
  const config={stateDir:'/tmp/x',setupsFile:'/tmp/x/setups.json'};
  await mod.upsertSetup({symbol:'NEARUSDT',side:'long',triggerPrice:5}, {config,fsImpl});
  await mod.upsertSetup({symbol:'NEARUSDT',side:'short',triggerPrice:4.9}, {config,fsImpl});
  await mod.upsertSetup({symbol:'STRKUSDT',side:'short',triggerPrice:0.11}, {config,fsImpl});
  let rows=await mod.readSetups({config,fsImpl});
  assert.deepEqual(rows.map(x=>`${x.symbol}:${x.side}`),['NEARUSDT:long','NEARUSDT:short','STRKUSDT:short']);
  await mod.removeSetup('NEARUSDT',{config,fsImpl});
  rows=await mod.readSetups({config,fsImpl});
  assert.deepEqual(rows.map(x=>x.symbol),['STRKUSDT']);
});

test('price resolver prefers currentMid from the local feed without external request', async () => {
  const mod=await loadModule(); assert.ok(mod);
  let fetched=false;
  const price=await mod.resolveSnapshotPrice({currentMid:123.45},'BTCUSDT',{fetchImpl:async()=>{fetched=true; throw new Error('unexpected');}});
  assert.equal(price,123.45);
  assert.equal(fetched,false);
});

test('price resolver falls back to public Binance spot price for an older local feed', async () => {
  const mod=await loadModule(); assert.ok(mod);
  let requested;
  const price=await mod.resolveSnapshotPrice({},'ETHUSDT',{fetchImpl:async url=>{
    requested=String(url);
    return {ok:true,json:async()=>({symbol:'ETHUSDT',price:'2468.75'})};
  }});
  assert.equal(requested,'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
  assert.equal(price,2468.75);
});

test('subscription refresh excludes core symbols and keeps dynamic symbols', async () => {
  const mod=await loadModule(); assert.ok(mod);
  const symbols=mod.dynamicSymbolsForRefresh([
    {symbol:'BTCUSDT'},{symbol:'NEARUSDT'},{symbol:'SOLUSDT'},{symbol:'STRKUSDT'}
  ]);
  assert.deepEqual(symbols,['NEARUSDT','STRKUSDT']);
});

test('subscription refresh cadence is minutes, not every watcher poll', async () => {
  const mod=await loadModule(); assert.ok(mod);
  assert.equal(mod.shouldRefreshSubscriptions(1_000,300_999,300_000),false);
  assert.equal(mod.shouldRefreshSubscriptions(1_000,301_000,300_000),true);
});

test('ENTRY_CANDIDATE notification plays motif then speaks with no added pause', async () => {
  const mod=await loadModule(); assert.ok(mod);
  const built=mod.buildNotification(
    {symbol:'BTCUSDT',side:'long'},
    {currentMid:83000,windows:{'60000':{aggressor:{imbalance:0.5}}}}
  );
  assert.match(built.title,/^🟢 BTCUSDT LONG/);

  const calls=[];
  const spawnImpl=(cmd,args,options)=>{ calls.push({cmd,args,options}); return {unref(){}}; };
  const result=mod.sendMacNotification(built,{spawnImpl});
  assert.deepEqual(result,built);
  assert.equal(calls.length,2);
  assert.equal(calls[0].cmd,'/usr/bin/osascript');
  assert.equal(calls[1].cmd,'/bin/sh');
  assert.deepEqual(calls[1].args.slice(0,2),['-c',calls[1].args[1]]);
  assert.match(calls[1].args[1],/afplay/);
  assert.match(calls[1].args[1],/sleep 0/);
  assert.match(calls[1].args[1],/say -v Milena/);
  assert.match(calls[1].args[3],/assets\/watcher-entry-candidate\.wav$/);
  assert.equal(calls[1].options.detached,true);
});

test('pipeline watcher sync atomically replaces stale levels using conservative defaults', async () => {
  const mod=await loadModule(); assert.ok(mod);
  let stored=JSON.stringify([
    mod.normalizeSetup({symbol:'BTCUSDT',side:'long',triggerPrice:83850}),
    mod.normalizeSetup({symbol:'SOLUSDT',side:'short',triggerPrice:105.5})
  ]);
  const fsImpl={
    mkdir:async()=>{},
    readFile:async()=>stored,
    writeFile:async(_path,value)=>{stored=String(value);},rename:async()=>{},unlink:async()=>{}
  };
  const config={stateDir:'/tmp/x',setupsFile:'/tmp/x/setups.json'};
  const result=await mod.syncSetups([
    {symbol:'BTCUSDT',side:'long',triggerPrice:83350},
    {symbol:'BTCUSDT',side:'short',triggerPrice:82900},
    {symbol:'ETHUSDT',side:'long',triggerPrice:2516}
  ],{config,fsImpl});
  assert.deepEqual(result.changes.added,['BTCUSDT:short','ETHUSDT:long']);
  assert.deepEqual(result.changes.updated,['BTCUSDT:long']);
  assert.deepEqual(result.changes.removed,['SOLUSDT:short']);
  const rows=await mod.readSetups({config,fsImpl});
  assert.equal(rows.length,3);
  assert.deepEqual(rows[0],{
    symbol:'BTCUSDT',side:'long',triggerPrice:83350,holdMs:30_000,minImbalance:0.30,
    confirmationsRequired:2,confirmationIntervalMs:12_000,requireImpact:true,absorptionVeto:true,enabled:true
  });
});

test('pipeline watcher sync rejects duplicate symbol-side identities', async () => {
  const mod=await loadModule(); assert.ok(mod);
  const fsImpl={mkdir:async()=>{},readFile:async()=>{const e=new Error('missing');e.code='ENOENT';throw e;},writeFile:async()=>{}};
  await assert.rejects(
    mod.syncSetups([
      {symbol:'NEARUSDT',side:'long',triggerPrice:5.08},
      {symbol:'NEARUSDT',side:'long',triggerPrice:5.09}
    ],{config:{stateDir:'/tmp/x',setupsFile:'/tmp/x/setups.json'},fsImpl}),
    /duplicate_setup_identity/
  );
});

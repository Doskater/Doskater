import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {NOW} from './helpers/entry-fixtures.js';
let mod;try{mod=await import('../entry-command.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
function decision(changes={}) {return {stage:'final',decision:'ENTER_REDUCED',checkedAt:NOW,candidateId:'candidate-1',symbol:'NEARUSDT',side:'short',entry:4.91,
  invalidationPrice:4.98,targets:[{price:4.78}],qty:'5',positionIdx:0,...changes};}
test('terminal payload binds protected IOC entry and SL/TP without execution',()=>{
  assert.equal(typeof mod?.buildEntryPayload,'function');
  const p=mod.buildEntryPayload(decision());
  assert.equal(p.symbol,'NEARUSDT');assert.equal(p.side,'Sell');assert.equal(p.qty,'5');assert.equal(p.price,'4.91');
  assert.equal(p.orderType,'Limit');assert.equal(p.timeInForce,'IOC');assert.equal(p.stopLoss,'4.98');assert.equal(p.takeProfit,'4.78');
  assert.equal(p.category,'linear');assert.equal(p.reduceOnly,false);assert.equal(p.tpslMode,'Partial');assert.equal(p.positionIdx,0);
  assert.equal(p.tpOrderType,'Market');assert.equal(p.slOrderType,'Market');assert.ok(p.orderLinkId.length<=36);
  const long=mod.buildEntryPayload(decision({side:'long',entry:100,invalidationPrice:98,targets:[{price:104}],positionIdx:1}));
  assert.equal(long.side,'Buy');assert.equal(long.positionIdx,1);
});
test('terminal command shell-quotes import path and JavaScript parses without running order',()=>{
  assert.equal(typeof mod?.buildTerminalCommand,'function');
  const cmd=mod.buildTerminalCommand(decision(),{clientPath:"/tmp/client's folder/bybit-client.js"});
  const parsed=spawnSync('/bin/sh',['-n','-c',cmd],{encoding:'utf8'});
  assert.equal(parsed.status,0,parsed.stderr);
  const quoted=cmd.slice(cmd.indexOf(" -e ")+4);
  const source=quoted.slice(1,-1).split("'\\''").join("'");
  const syntax=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});
  assert.equal(syntax.status,0,syntax.stderr);
  assert.match(source,/BYBIT_DEMO_API_KEY/);assert.match(source,/BYBIT_DEMO_API_SECRET/);
  assert.match(source,/command_expired/);assert.match(source,/Date.now/);
});
test('command builder refuses preliminary, non-enter and malicious or inconsistent order fields',()=>{
  assert.equal(typeof mod?.buildTerminalCommand,'function');
  for(const changes of [{stage:'preliminary'},{decision:'WAIT_RETEST'},{symbol:'$(touch /tmp/unexpected)'},{qty:'1;touch /tmp/unexpected'},{side:'SHORT'},{entry:NaN},{invalidationPrice:4.7},{targets:[{price:5}]},{positionIdx:1}]) {
    assert.throws(()=>mod.buildTerminalCommand(decision(changes)),/invalid_|final_enter_required/);
  }
});

test('command expiration is checked again after asynchronous client loading',async()=>{
  const command=mod.buildTerminalCommand(decision());
  const quoted=command.slice(command.indexOf(' -e ')+4);
  const source=quoted.slice(1,-1).split("'\\''").join("'");
  // Replace only the external import boundary; run the real emitted guards/request control flow.
  const executable=source.replace('await import(','await importClient(');
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  let time=NOW+4999,requests=0;
  const importer=async()=>{time+=2;return {createBybitClient:()=>({request:async()=>{requests++;return {};}})};};
  await assert.rejects(new AsyncFunction('Date','process','console','importClient',executable)(
    {now:()=>time},{env:{}},{log(){}},importer),/command_expired/);
  assert.equal(requests,0);
});
test('payload preserves small quantities as plain decimal strings',()=>{
  const p=mod.buildEntryPayload(decision({qty:'0.00000001'}));
  assert.equal(p.qty,'0.00000001');
});

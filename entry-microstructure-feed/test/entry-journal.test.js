import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {snapshot,NOW} from './helpers/entry-fixtures.js';
import * as watcher from '../trigger-watcher.js';
let journal;
try {journal=await import('../entry-journal.js');} catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const setup={symbol:'NEARUSDT',side:'short',triggerPrice:4.94,holdMs:0,confirmationsRequired:1};
test('candidate detaches snapshot and identifies side, setup version and confirmation',()=>{
  assert.equal(typeof journal?.createCandidate,'function');
  const source=snapshot();
  const a=journal.createCandidate(watcher.normalizeSetup(setup),source,{now:()=>NOW});
  const b=journal.createCandidate(watcher.normalizeSetup(setup),source,{now:()=>NOW});
  const long=journal.createCandidate(watcher.normalizeSetup({...setup,side:'long'}),source,{now:()=>NOW});
  source.windows['60000'].aggressor.imbalance=0;
  assert.equal(a.microstructure.windows['60000'].aggressor.imbalance,-0.5);
  assert.equal(a.observedPrice,4.93);assert.equal(a.detectedAt,NOW);assert.equal(a.symbol,'NEARUSDT');
  assert.equal(a.setupId,b.setupId);assert.notEqual(a.candidateId,b.candidateId);assert.notEqual(a.setupId,long.setupId);
});
test('real JSONL roundtrip retains candidate and rejects unknown or corrupt journal',async()=>{
  assert.equal(typeof journal?.appendEntryEvent,'function');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'entry-journal-'));
  try {
    const journalFile=path.join(dir,'nested','entries.jsonl');
    const c=journal.createCandidate(watcher.normalizeSetup(setup),snapshot(),{now:()=>NOW});
    await journal.appendEntryEvent({event:'ENTRY_CANDIDATE',timestamp:NOW,candidate:c,candidateId:c.candidateId,setupId:c.setupId},{journalFile});
    assert.deepEqual(await journal.readCandidate(c.candidateId,{journalFile}),c);
    await assert.rejects(journal.readCandidate('unknown',{journalFile}),/candidate_not_found/);
    const permissions=(await fs.stat(journalFile)).mode&0o777;
    assert.equal(permissions,0o600);
    await fs.appendFile(journalFile,'bad-json\n');
    await assert.rejects(journal.readCandidate(c.candidateId,{journalFile}),/journal_corrupt/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('failed candidate write retries before latch and notification',async()=>{
  assert.equal(typeof watcher.processSetupSnapshot,'function');
  let fail=true;const written=[];const notified=[];
  const options={now:()=>NOW,writeCandidate:async c=>{if(fail)throw Error('disk');written.push(c);},notify:()=>{assert.equal(written.length,1);notified.push(true);}};
  const first=await watcher.processSetupSnapshot(setup,snapshot(),watcher.createSetupState(),options);
  assert.equal(first.state.latched,false);assert.equal(first.alert,false);assert.equal(notified.length,0);
  fail=false;
  const next=await watcher.processSetupSnapshot(setup,snapshot(),first.state,options);
  assert.equal(next.state.latched,true);assert.equal(next.alert,true);assert.equal(written.length,1);assert.equal(notified.length,1);
  await watcher.processSetupSnapshot(setup,snapshot(),next.state,options);
  assert.equal(written.length,1);
});
test('notification failure after durable candidate does not re-emit it',async()=>{
  assert.equal(typeof watcher.processSetupSnapshot,'function');
  let writes=0;
  const opts={now:()=>NOW,writeCandidate:async()=>{writes++;},notify:()=>{throw Error('notification');}};
  const r=await watcher.processSetupSnapshot(setup,snapshot(),watcher.createSetupState(),opts);
  assert.equal(r.state.latched,true);assert.equal(r.notificationError,'notification');
  await watcher.processSetupSnapshot(setup,snapshot(),r.state,opts);
  assert.equal(writes,1);
});

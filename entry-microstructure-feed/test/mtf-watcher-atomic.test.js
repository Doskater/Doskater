import test from 'node:test';
import assert from 'node:assert/strict';
import {syncSetups,normalizeSetup} from '../trigger-watcher.js';

test('watcher config replacement uses a complete temporary file before atomic rename',async()=>{
  const config={stateDir:'/tmp/mtf-test',setupsFile:'/tmp/mtf-test/setups.json'};
  const old=JSON.stringify([normalizeSetup({symbol:'NEARUSDT',side:'long',triggerPrice:99})]);
  let stored=old,temp,renamed=false;
  const fsImpl={mkdir:async()=>{},readFile:async()=>stored,
    writeFile:async(file,value)=>{assert.notEqual(file,config.setupsFile);temp=value;assert.equal(stored,old);},
    rename:async(from,to)=>{assert.notEqual(from,to);assert.equal(to,config.setupsFile);stored=temp;renamed=true;},
    unlink:async()=>{}};
  await syncSetups([{symbol:'NEARUSDT',side:'long',triggerPrice:100}],{config,fsImpl});
  assert.equal(renamed,true);assert.equal(JSON.parse(stored)[0].triggerPrice,100);
});
test('failed watcher replacement keeps old config and cleans temporary file',async()=>{
  const old=JSON.stringify([normalizeSetup({symbol:'NEARUSDT',side:'short',triggerPrice:99})]);
  let cleaned=false;
  await assert.rejects(syncSetups([{symbol:'NEARUSDT',side:'long',triggerPrice:100}],{
    config:{stateDir:'/tmp/mtf-test',setupsFile:'/tmp/mtf-test/setups.json'},
    fsImpl:{mkdir:async()=>{},readFile:async()=>old,writeFile:async()=>{},rename:async()=>{throw Error('rename_failed');},
      unlink:async()=>{cleaned=true;}}}),/rename_failed/);
  assert.equal(cleaned,true);
});
